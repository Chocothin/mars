/**
 * Step 5: AST post-processing for generated React files.
 * - Normalize import ordering
 * - Normalize className token ordering
 * - Normalize boolean props to shorthand
 *
 * Usage:
 *   npx jscodeshift -t design/pipeline/postprocess_ast.js frontend/src/generated --extensions=ts,tsx --parser=tsx
 */

module.exports = function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1) Sort import declarations by source path.
  const imports = root.find(j.ImportDeclaration);
  if (imports.size() > 1) {
    const sorted = imports
      .nodes()
      .slice()
      .sort((a, b) => String(a.source.value).localeCompare(String(b.source.value)));
    imports.at(0).replaceWith(sorted[0]);
    for (let i = 1; i < sorted.length; i += 1) {
      imports.at(i).replaceWith(sorted[i]);
    }
  }

  // 2) Sort className utility tokens alphabetically for deterministic output.
  root.find(j.JSXAttribute, { name: { name: "className" } }).forEach((p) => {
    const value = p.node.value;
    if (!value) {
      return;
    }
    if (value.type === "Literal" || value.type === "StringLiteral") {
      const raw = String(value.value || "").trim();
      if (!raw) {
        return;
      }
      const sorted = raw
        .split(/\s+/)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .join(" ");
      value.value = sorted;
    }
  });

  // 3) Convert explicit true props (<Comp disabled={true}>) to shorthand (<Comp disabled>). 
  root.find(j.JSXAttribute).forEach((p) => {
    const attr = p.node;
    if (!attr.value || attr.value.type !== "JSXExpressionContainer") {
      return;
    }
    const expr = attr.value.expression;
    if (expr && expr.type === "BooleanLiteral" && expr.value === true) {
      attr.value = null;
    }
  });

  return root.toSource({ quote: "double", trailingComma: true });
};
