/**
 * Flags hardcoded CJK text in source so it cannot bypass the localization
 * mechanisms documented in DESIGN.md.
 *
 * A literal is allowed when it sits in one of the recognized localized
 * contexts, which are resolved by walking up the AST:
 *
 *   - an argument of `text()`, `i18nText()`, `tt()` (the per-component alias in
 *     SshTerminalTab / BackgroundScheduledTaskRunner), `trf!()` or the
 *     `friendlyLoginError(raw, zh, en, locale)` helper
 *   - a `{ zh, en }` style option-table value
 *   - either arm of a ternary, or a branch guarded by an `en` / `zh` / `locale`
 *     test, which is where locale-conditional pairs live
 *   - anywhere inside a function that takes a `locale` parameter, which is the
 *     convention for locale-aware helpers in `src/lib`
 *
 * Everything else — JSX text, attribute values, `new Error("...")`, string
 * matching against native messages — is reported.
 */

// CJK Unified Ideographs, plus the Extension A and Compatibility blocks.
// Written with escapes so this file stays ASCII and cannot flag itself.
const CJK = new RegExp("[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]");

const LOCALIZING_CALLS = new Set(["text", "i18nText", "tt", "trf", "friendlyLoginError"]);

// Matches an `if` guard that switches on the active language.
const LOCALE_TEST = /\b(en|zh|locale)\b/;

const LOCALIZED_PROPERTY_KEYS = new Set([
  "zh",
  "en",
  "descriptionZh",
  "descriptionEn",
  "messageZh",
  "messageEn",
  "labelZh",
  "labelEn",
]);

function propertyKeyName(property) {
  const key = property.key;
  if (!key) return null;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return null;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** `locale: Locale = "zh-CN"` and friends, minus the type annotation. */
function bindingName(param) {
  if (!param) return null;
  if (param.type === "Identifier") return param.name;
  if (param.type === "AssignmentPattern") return bindingName(param.left);
  return null;
}

function hasLocaleParam(fn) {
  for (const param of fn.params ?? []) {
    const name = bindingName(param);
    if (name === "locale" || name === "lang") return true;
  }
  return false;
}

/** True when `node` sits inside one of the recognized localized contexts. */
function insideLocalizingContext(node, sourceCode) {
  let child = node;
  let parent = node.parent;
  while (parent) {
    if (parent.type === "CallExpression") {
      const callee = parent.callee;
      if (callee.type === "Identifier" && LOCALIZING_CALLS.has(callee.name)) return true;
      if (
        callee.type === "MemberExpression" &&
        callee.property.type === "Identifier" &&
        LOCALIZING_CALLS.has(callee.property.name)
      ) {
        return true;
      }
    }
    if (parent.type === "ConditionalExpression") return true;
    if (parent.type === "IfStatement" && LOCALE_TEST.test(sourceCode.getText(parent.test))) {
      return true;
    }
    if (FUNCTION_TYPES.has(parent.type) && hasLocaleParam(parent)) return true;
    if (parent.type === "Property" && parent.value === child) {
      const name = propertyKeyName(parent);
      if (name && LOCALIZED_PROPERTY_KEYS.has(name)) return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow hardcoded CJK text outside the localization helpers",
    },
    messages: {
      bareCjk:
        "Hardcoded CJK text. Route it through text(zh, en), i18nText(zh, en), tt(zh, en) or the i18n dictionary, or disable this line with a reason.",
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function check(node, value) {
      if (!CJK.test(value)) return;
      if (insideLocalizingContext(node, sourceCode)) return;
      context.report({ node, messageId: "bareCjk" });
    }

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
};

export default { rules: { "no-bare-cjk": rule } };
