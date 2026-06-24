import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve("src");

async function main() {
  const files = await sourceFiles(root);
  const failures: string[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    visitSourceFile(source, failures);
  }

  if (failures.length > 0) {
    throw new Error(`Missing exported JSDoc:\n${failures.join("\n")}`);
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(fullPath)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function visitSourceFile(source: ts.SourceFile, failures: string[]) {
  for (const statement of source.statements) {
    if (isExportedDeclaration(statement) && requiresExportedJSDoc(statement)) {
      if (!hasJSDoc(source, statement)) {
        failures.push(`${source.fileName}:${lineOf(source, statement)} ${declarationName(statement)}`);
      }
      for (const name of missingTemplateTags(source, statement)) {
        failures.push(`${source.fileName}:${lineOf(source, statement)} ${declarationName(statement)} missing @template ${name}`);
      }
    }

    if (ts.isClassDeclaration(statement) && isExportedDeclaration(statement)) {
      for (const member of statement.members) {
        if (requiresPublicMemberJSDoc(member)) {
          if (!hasJSDoc(source, member)) {
            failures.push(`${source.fileName}:${lineOf(source, member)} ${declarationName(statement)}.${memberName(member)}`);
          }
          for (const name of missingTemplateTags(source, member)) {
            failures.push(`${source.fileName}:${lineOf(source, member)} ${declarationName(statement)}.${memberName(member)} missing @template ${name}`);
          }
        }
      }
    }
  }
}

function requiresExportedJSDoc(statement: ts.Statement) {
  return (
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isVariableStatement(statement)
  );
}

function requiresPublicMemberJSDoc(member: ts.ClassElement) {
  return (
    (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
    !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
    !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
  );
}

function isExportedDeclaration(statement: ts.Statement) {
  return hasModifier(statement, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function hasJSDoc(source: ts.SourceFile, node: ts.Node) {
  return jsDocText(source, node) !== undefined;
}

function jsDocText(source: ts.SourceFile, node: ts.Node) {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  const range = ranges.find((item) => source.text.slice(item.pos, item.end).startsWith("/**"));
  return range ? source.text.slice(range.pos, range.end) : undefined;
}

function missingTemplateTags(source: ts.SourceFile, node: ts.Node) {
  const typeParameters = typeParametersOf(node);
  if (typeParameters.length === 0) return [];
  const doc = jsDocText(source, node) ?? "";
  return typeParameters
    .map((parameter) => parameter.name.getText(source))
    .filter((name) => !new RegExp(`@template\\s+${name}\\b`).test(doc));
}

function typeParametersOf(node: ts.Node): readonly ts.TypeParameterDeclaration[] {
  if (
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.typeParameters ?? [];
  }
  return [];
}

function declarationName(statement: ts.Statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declaration) => declaration.name.getText()).join(", ");
  }
  if (
    (ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.getText();
  }
  return "default";
}

function memberName(member: ts.ClassElement) {
  if (ts.isConstructorDeclaration(member)) return "constructor";
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) return member.name.getText();
  return "member";
}

function lineOf(source: ts.SourceFile, node: ts.Node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

await main();
