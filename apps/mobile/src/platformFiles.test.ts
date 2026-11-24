import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Metro resolves `./Foo` to `Foo.ios.tsx` on iOS and never reads `Foo.tsx` there, while
// TypeScript only ever sees `Foo.tsx`. A value the shared file exports and the platform file
// does not passes the typecheck and is undefined on the device. Types are erased, so only
// values need to match.

// The mobile app has no Node types; TypeScript's own file system calls stand in for `node:fs`.
const root = decodeURIComponent(new URL('.', import.meta.url).pathname);
const platform = /\.(ios|android|native|web)\.tsx?$/;

function bindingNames(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
}

function valueExports(path: string) {
  const source = ts.createSourceFile(path, ts.sys.readFile(path) ?? '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause) names.add(`* from ${(statement.moduleSpecifier as ts.StringLiteral).text}`);
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.add(element.name.text);
      } else names.add(statement.exportClause.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) { names.add('default'); continue; }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    if (!modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) { names.add('default'); continue; }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  return names;
}

const pairs = ts.sys.readDirectory(root, ['.ts', '.tsx']).filter(path => platform.test(path) && !path.includes('.test.')).map(path => {
  const stem = path.replace(platform, '');
  const shared = [`${stem}.tsx`, `${stem}.ts`].find(ts.sys.fileExists);
  return { path, shared };
});

describe('platform files', () => {
  it('finds some', () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  it.each(pairs.map(pair => [pair.path.slice(root.length), pair] as const))('%s exports every value its shared file does', (_, { path, shared }) => {
    if (!shared) return;
    const own = valueExports(path);
    expect([...valueExports(shared)].filter(name => !own.has(name))).toEqual([]);
  });
});
