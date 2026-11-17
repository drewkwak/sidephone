// Page inspection used by the content script: the mobile layout checks, the
// page's media query breakpoints, and finding "the same element" again in
// another copy of the page. It reads layout only; it never changes the page.
//
// A classic script, loaded before content/main.js in the same isolated world.
// It defines globalThis.SidephoneChecks, which the unit tests load too.
(function (root) {
  // Apple's minimum touch target is 44 by 44 points.
  const MIN_TAP_TARGET = 44;
  // Safari on iPhone zooms the page in when a field with smaller text is focused.
  const MIN_INPUT_FONT = 16;
  const MIN_TEXT_SIZE = 12;
  const MAX_PER_KIND = 25;
  // Large pages: inspect this many elements at most per check.
  const MAX_ELEMENTS = 6000;

  const TEXT_INPUT_TYPES = new Set([
    "text",
    "search",
    "email",
    "url",
    "password",
    "tel",
    "number",
    "date",
    "datetime-local",
    "month",
    "time",
    "week",
  ]);
  const INTERACTIVE = [
    "a[href]",
    "button",
    "select",
    "textarea",
    "summary",
    "input:not([type=hidden])",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
  ].join(",");

  // ---------- helpers ----------

  function isRendered(el, style) {
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  /** A short, readable name for an element: `button.cta "Sign in"`. */
  function describe(el) {
    let name = el.tagName.toLowerCase();
    if (el.id) name += `#${el.id}`;
    else {
      const classes = [...el.classList].filter((c) => c.length <= 30).slice(0, 2);
      if (classes.length) name += `.${classes.join(".")}`;
    }
    const text = (
      el.getAttribute("aria-label") ||
      el.textContent ||
      el.getAttribute("placeholder") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (text && el.children.length <= 3)
      name += ` "${text.length > 28 ? `${text.slice(0, 27)}…` : text}"`;
    return name.slice(0, 80);
  }

  const round = (n) => Math.round(n);

  // ---------- mobile layout checks ----------

  /**
   * Find the problems a phone user would hit on the current page.
   * @returns {{kind: string, severity: "error" | "warning", element: Element, label: string, detail: string}[]}
   */
  function findIssues(doc = document, win = window) {
    const issues = [];
    const counts = {};
    const add = (kind, severity, element, detail) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (counts[kind] > MAX_PER_KIND) return;
      issues.push({ kind, severity, element, label: describe(element), detail });
    };
    if (!doc.body) return issues;

    const viewportWidth = doc.documentElement.clientWidth;
    const elements = [doc.body, ...doc.body.getElementsByTagName("*")].slice(0, MAX_ELEMENTS);
    const styles = new Map();
    const styleOf = (el) => {
      let style = styles.get(el);
      if (!style) {
        style = win.getComputedStyle(el);
        styles.set(el, style);
      }
      return style;
    };

    findOverflow(elements, viewportWidth, styleOf, add);
    findSmallTapTargets(doc, styleOf, add);
    findSmallInputText(doc, styleOf, add);
    findSmallText(elements, styleOf, add);

    // Something makes the page wider than the screen, but no single element
    // could be pinned down (a margin, a transform, a pseudo-element).
    const pageWidth = doc.documentElement.scrollWidth;
    if (pageWidth > viewportWidth + 1 && !issues.some((issue) => issue.kind === "overflow")) {
      add(
        "overflow",
        "error",
        doc.body,
        `The page is ${pageWidth}px wide on a ${viewportWidth}px screen, so it scrolls sideways`,
      );
    }

    return issues;
  }

  // Elements that stick out past the side of the screen. Only the outermost
  // one is reported: its children stick out because it does.
  function findOverflow(elements, viewportWidth, styleOf, add) {
    const clips = new Map(); // element -> true if it or an ancestor clips horizontally
    const clipped = (el) => {
      if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement)
        return false;
      if (clips.has(el)) return clips.get(el);
      const style = styleOf(el);
      const result = style.overflowX !== "visible" || clipped(el.parentElement);
      clips.set(el, result);
      return result;
    };
    const overflowing = new Set();

    for (const el of elements) {
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      const style = styleOf(el);
      if (!isRendered(el, style)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      // Entirely off screen: a closed drawer or menu, not a layout bug.
      if (rect.left >= viewportWidth || rect.right <= 0) continue;
      if (clipped(el.parentElement)) continue;

      const boxOverflows = rect.right > viewportWidth + 1 || rect.left < -1;
      // Text can run past its own box: a long word or URL that cannot wrap.
      const textOverflows =
        !boxOverflows &&
        style.overflowX === "visible" &&
        el.scrollWidth > el.clientWidth + 1 &&
        rect.left + el.scrollWidth > viewportWidth + 1 &&
        [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());

      if (!boxOverflows && !textOverflows) continue;
      overflowing.add(el);
      if (overflowing.has(el.parentElement)) continue;

      if (textOverflows) {
        add(
          "overflow",
          "error",
          el,
          "Text runs past the edge of the screen. A long word or URL can't wrap.",
        );
      } else {
        const past = round(Math.max(rect.right - viewportWidth, -rect.left));
        add(
          "overflow",
          "error",
          el,
          `${round(rect.width)}px wide, ${past}px past the edge of a ${viewportWidth}px screen`,
        );
      }
    }
  }

  function findSmallTapTargets(doc, styleOf, add) {
    const reported = new Set();
    for (const el of doc.querySelectorAll(INTERACTIVE)) {
      const style = styleOf(el);
      if (!isRendered(el, style)) continue;
      // A link inside a sentence is exempt: it is sized by the text around it.
      if (style.display === "inline" && el.matches("a, [role=link]")) continue;
      // A checkbox or radio inside a label is tapped through the label.
      const target = el.matches("input[type=checkbox], input[type=radio]")
        ? (el.closest("label") ?? el)
        : el;
      if ([...reported].some((parent) => parent.contains(target))) continue;
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.width >= MIN_TAP_TARGET && rect.height >= MIN_TAP_TARGET) continue;
      reported.add(target);
      add(
        "tap-target",
        "warning",
        target,
        `${round(rect.width)} × ${round(rect.height)}px. Touch targets should be at least ${MIN_TAP_TARGET} × ${MIN_TAP_TARGET}px.`,
      );
    }
  }

  function findSmallInputText(doc, styleOf, add) {
    for (const el of doc.querySelectorAll("input, textarea, select")) {
      if (
        el.tagName === "INPUT" &&
        !TEXT_INPUT_TYPES.has((el.getAttribute("type") || "text").toLowerCase())
      )
        continue;
      const style = styleOf(el);
      if (!isRendered(el, style)) continue;
      const size = parseFloat(style.fontSize);
      if (!(size < MIN_INPUT_FONT)) continue;
      add(
        "input-zoom",
        "warning",
        el,
        `Text is ${size}px. On iPhone, tapping a field with text under ${MIN_INPUT_FONT}px zooms the page in.`,
      );
    }
  }

  function findSmallText(elements, styleOf, add) {
    for (const el of elements) {
      if (el.matches("script, style, noscript, template, svg *, sup, sub, [aria-hidden=true]"))
        continue;
      const hasOwnText = [...el.childNodes].some(
        (node) => node.nodeType === 3 && node.textContent.trim(),
      );
      if (!hasOwnText) continue;
      const style = styleOf(el);
      if (!isRendered(el, style)) continue;
      const size = parseFloat(style.fontSize);
      if (!(size < MIN_TEXT_SIZE)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      add("small-text", "warning", el, `Text is ${size}px, hard to read on a phone.`);
    }
  }

  // ---------- breakpoints ----------

  const LENGTH = String.raw`(\d*\.?\d+)(px|em|rem)`;
  const toPx = (value, unit) => Number(value) * (unit === "px" ? 1 : 16);

  /**
   * The widths at which a media query's result changes, as integers: the
   * page looks one way below each width and another way from it upward.
   * "(min-width: 768px)" and "(max-width: 767px)" both give 768.
   * @param {string} mediaText
   * @returns {number[]}
   */
  function parseMediaBoundaries(mediaText) {
    const text = mediaText.toLowerCase();
    const found = [];
    const push = (n) => {
      if (Number.isFinite(n) && n > 0 && n < 10000) found.push(n);
    };

    // Classic syntax.
    for (const match of text.matchAll(
      new RegExp(String.raw`\((min|max)-width\s*:\s*${LENGTH}\s*\)`, "g"),
    )) {
      const px = toPx(match[2], match[3]);
      push(match[1] === "min" ? Math.ceil(px) : Math.floor(px) + 1);
    }

    // Range syntax: (width >= 640px), (width < 1024px), (640px <= width < 1024px).
    // The two sides are matched separately: in the double form both share "width".
    for (const match of text.matchAll(
      new RegExp(String.raw`width\s*(<=|>=|<|>)\s*${LENGTH}`, "g"),
    )) {
      const px = toPx(match[2], match[3]);
      // width >= X and width < X change at X; width > X and width <= X just after it.
      push(match[1] === ">=" || match[1] === "<" ? Math.ceil(px) : Math.floor(px) + 1);
    }
    for (const match of text.matchAll(
      new RegExp(String.raw`${LENGTH}\s*(<=|>=|<|>)\s*width`, "g"),
    )) {
      const px = toPx(match[1], match[2]);
      // X <= width and X > width change at X; X < width and X >= width just after it.
      push(match[3] === "<=" || match[3] === ">" ? Math.ceil(px) : Math.floor(px) + 1);
    }
    return found;
  }

  /**
   * Every width breakpoint in the page's stylesheets. Stylesheets loaded from
   * another origin cannot be read and are counted instead.
   * @returns {{widths: number[], unreadable: number}}
   */
  function readBreakpoints(doc = document) {
    const widths = new Set();
    let unreadable = 0;
    const seen = new Set();

    const visitRules = (rules) => {
      for (const rule of rules) {
        if (rule.media && rule.type === 4 /* CSSMediaRule */) {
          for (const width of parseMediaBoundaries(rule.media.mediaText)) widths.add(width);
        }
        if (rule.styleSheet) visitSheet(rule.styleSheet); // @import
        if (rule.cssRules) visitRules(rule.cssRules); // @media, @supports, @layer
      }
    };
    const visitSheet = (sheet) => {
      if (!sheet || seen.has(sheet)) return;
      seen.add(sheet);
      if (sheet.media?.mediaText) {
        for (const width of parseMediaBoundaries(sheet.media.mediaText)) widths.add(width);
      }
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        unreadable++;
        return;
      }
      visitRules(rules);
    };

    for (const sheet of doc.styleSheets) visitSheet(sheet);
    for (const sheet of doc.adoptedStyleSheets ?? []) visitSheet(sheet);
    return { widths: [...widths].sort((a, b) => a - b), unreadable };
  }

  // ---------- finding the same element in another copy of the page ----------

  /** A description of an element that can find it again in another copy of the page. */
  function locatorFor(el) {
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== node.ownerDocument.body) {
      if (node.id && node.ownerDocument.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        path.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const sameTag = [...(node.parentElement?.children ?? [])].filter(
        (sibling) => sibling.tagName === node.tagName,
      );
      path.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
      node = node.parentElement;
    }
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return {
      path: path.join(" > "),
      id: el.id || "",
      testId: el.getAttribute("data-testid") || el.getAttribute("data-test-id") || "",
      tag: el.tagName.toLowerCase(),
      text,
    };
  }

  /** Find an element from a locator, trying the most specific clue first. */
  function findByLocator(locator, doc = document) {
    const attempt = (selector) => {
      try {
        return selector ? doc.querySelector(selector) : null;
      } catch {
        return null;
      }
    };
    const visible = (el) => el && el.getClientRects().length > 0;

    const byId = locator.id ? attempt(`#${CSS.escape(locator.id)}`) : null;
    if (visible(byId)) return byId;
    const byTestId = locator.testId
      ? attempt(`[data-testid="${CSS.escape(locator.testId)}"]`)
      : null;
    if (visible(byTestId)) return byTestId;
    const byPath = locator.path
      ? attempt(locator.path.startsWith("#") ? locator.path : `body > ${locator.path}`)
      : null;
    if (visible(byPath)) return byPath;

    // The mobile layout may render different markup. Fall back to the same
    // kind of element with the same text.
    if (locator.text && /^[a-z][a-z0-9-]*$/.test(locator.tag)) {
      for (const el of doc.getElementsByTagName(locator.tag)) {
        if (!visible(el)) continue;
        if ((el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) === locator.text)
          return el;
      }
    }
    return null;
  }

  root.SidephoneChecks = Object.freeze({
    findIssues,
    describe,
    parseMediaBoundaries,
    readBreakpoints,
    locatorFor,
    findByLocator,
  });
})(globalThis);
