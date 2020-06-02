import * as ts from 'typescript';
import glob from 'glob';
import path from 'path';
import fs from 'fs';
import prettier from 'prettier';

interface ValidationSchema {
  name: string;
  properties: { [key: string]: ValidatorConfig[] };
}

interface ValidatorConfig {
  type: string;
  constraints: ts.Expression[];
  message?: ts.StringLiteral | ts.ArrowFunction;
  each?: ts.BooleanLiteral;
  always?: ts.BooleanLiteral;
  groups?: ts.ArrayLiteralExpression;
}

const OPTION_NAMES = ['message', 'each', 'always', 'groups'];

type ValidatorOptions = Omit<ValidatorConfig, 'type' | 'constraints'>;

const base_dir = process.argv[2];
const source_glob = process.argv[3];
const dist_dir = process.argv[4];

const base = path.join(process.cwd(), base_dir);
const dist = path.join(process.cwd(), dist_dir);

// Check if dist directory exist
if (!fs.existsSync(dist)) {
  // Create directory path
  fs.mkdirSync(dist, { recursive: true });
}

const getFileNames = (): string[] =>
  glob.sync(source_glob, { cwd: base, absolute: true });

interface File {
  name: string;
  content: string;
}

const loadFile = (fileName: string): File => ({
  name: fileName,
  content: fs.readFileSync(fileName).toString(),
});

const createSourceFile = (file: File): ts.SourceFile =>
  ts.createSourceFile(file.name, file.content, ts.ScriptTarget.ESNext);

type CVDecoratorNames = Array<{
  name: string;
  alias: string;
}>;

const extractCVDecoratorNames = (
  importDeclarations: ts.ImportDeclaration[]
): CVDecoratorNames => {
  const cvImportDeclarations = importDeclarations.filter(
    (importDeclaration) =>
      (importDeclaration.moduleSpecifier as ts.StringLiteral).text ===
      'class-validator'
  );

  const cvDecoratorNames = cvImportDeclarations.reduce<CVDecoratorNames>(
    (acc, importDeclaration) => {
      const importClause = importDeclaration.importClause;
      if (!importClause) return acc;
      const namedBindings = importClause.namedBindings;
      if (!namedBindings || namedBindings.kind !== ts.SyntaxKind.NamedImports)
        return acc;

      const decoratorNames = namedBindings.elements.map((importSpecifier) => {
        const alias = importSpecifier.name.text;
        const name =
          (importSpecifier.propertyName && importSpecifier.propertyName.text) ||
          importSpecifier.name.text;
        return { name, alias };
      });
      return [...acc, ...decoratorNames];
    },
    []
  );

  return cvDecoratorNames;
};

const decapitalize = (str: string) =>
  str.charAt(0).toLowerCase() + str.substr(1);

const isOptionsArg = (
  expression: ts.Expression
): expression is ts.ObjectLiteralExpression => {
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.every((property) => {
    const name = property.name;
    if (!name || !ts.isIdentifier(name)) return false;
    return OPTION_NAMES.includes(name.text);
  });
};

const extractValidatorOptionsFromOptionsArg = (
  optionsArg: ts.ObjectLiteralExpression
): ValidatorOptions => {
  return optionsArg.properties.reduce<ValidatorOptions>((acc, property) => {
    const name = property.name;
    if (!name || !ts.isIdentifier(name))
      throw new Error('Expected option property name to be indentifier');

    if (!ts.isPropertyAssignment(property))
      throw new Error('Expected option property to be property assignment');

    const initializer = property.initializer;
    if (
      name.text === 'message' &&
      !ts.isStringLiteral(initializer) &&
      !ts.isArrowFunction(initializer)
    )
      throw new Error(
        'Expected message to be string literal or arrow function'
      );

    if (
      name.text === 'each' &&
      initializer.kind !== ts.SyntaxKind.TrueKeyword &&
      initializer.kind !== ts.SyntaxKind.FalseKeyword
    )
      throw new Error('Expected each to be boolean literal');

    if (
      name.text === 'always' &&
      initializer.kind !== ts.SyntaxKind.TrueKeyword &&
      initializer.kind !== ts.SyntaxKind.FalseKeyword
    )
      throw new Error('Expected always to be boolean literal');

    if (name.text === 'groups') {
      if (!ts.isArrayLiteralExpression(initializer))
        throw new Error('Expected groups to be array literal');
      initializer.elements.forEach((element) => {
        if (!ts.isStringLiteral(element))
          throw new Error('Expected elements of groups to be string literals');
      });
    }

    return { ...acc, [name.text]: initializer };
  }, {});
};

const validateConstraints = (args: ts.Expression[]) => {
  args.forEach((arg) => {
    if (
      !ts.isStringLiteral(arg) &&
      !ts.isObjectLiteralExpression(arg) &&
      !ts.isRegularExpressionLiteral(arg) &&
      !ts.isNumericLiteral(arg)
    )
      throw new Error(`Expected constraint to be a string literal,
        an object literal expression, a regular expression or a numeric literal`);
  });
};

const extractValidatorsFromClassElement = (
  cvDecoratorNames: CVDecoratorNames,
  classElement: ts.ClassElement
): ValidatorConfig[] => {
  if (!classElement.decorators) return [];
  return classElement.decorators.reduce<ValidatorConfig[]>((acc, decorator) => {
    const callExpression = decorator.expression;
    if (!ts.isCallExpression(callExpression)) return acc;

    const identifier = callExpression.expression;
    if (!ts.isIdentifier(identifier)) return acc;

    const decoratorAlias = identifier.text;
    const cvDecoratorName = cvDecoratorNames.find(
      (cvDecoratorName) => cvDecoratorName.alias === decoratorAlias
    );
    if (!cvDecoratorName) return acc;

    let args = [...callExpression.arguments];

    const lastArg = args[args.length - 1];
    const optionsArg = lastArg && isOptionsArg(lastArg) ? lastArg : null;

    if (optionsArg) args = args.slice(0, args.length - 1);

    const options = optionsArg
      ? extractValidatorOptionsFromOptionsArg(optionsArg)
      : null;

    validateConstraints(args);

    return [
      ...acc,
      {
        type: decapitalize(cvDecoratorName.name),
        constraints: args,
        ...options,
      },
    ];
  }, []);
};

const extractCVSchemaFromClass = (
  cvDecoratorNames: CVDecoratorNames,
  classDeclaration: ts.ClassDeclaration
): ValidationSchema | null => {
  const properties = classDeclaration.members.reduce<
    ValidationSchema['properties']
  >((acc, classElement) => {
    if (
      !classElement.name ||
      classElement.name.kind !== ts.SyntaxKind.Identifier
    )
      return acc;
    const validators = extractValidatorsFromClassElement(
      cvDecoratorNames,
      classElement
    );
    if (validators.length === 0) return acc;
    return { ...acc, [classElement.name.text]: validators };
  }, {});

  if (Object.keys(properties).length === 0) return null;

  if (!classDeclaration.name)
    throw new Error('ClassValidator class declaration must be named');
  return { name: classDeclaration.name.text, properties };
};

const processSourceFile = (sourceFile: ts.SourceFile) => {
  const importDeclarations = sourceFile.statements.filter(
    ts.isImportDeclaration
  );

  const cvDecoratorNames = extractCVDecoratorNames(importDeclarations);

  const classDeclarations = sourceFile.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      statement.kind === ts.SyntaxKind.ClassDeclaration
  );

  const validationSchemas = classDeclarations
    .map((classDeclaration) =>
      extractCVSchemaFromClass(cvDecoratorNames, classDeclaration)
    )
    .filter((schema): schema is ValidationSchema => schema !== null);

  return validationSchemas;
};

const emitSchemasFile = (validationSchemas: ValidationSchema[]): File => {
  const sourceFile = ts.createSourceFile(
    'registerSchemas.ts',
    '',
    ts.ScriptTarget.ESNext
  );
  const printer = ts.createPrinter();
  const emitExpression = (node: ts.Node) =>
    printer.printNode(ts.EmitHint.Expression, node, sourceFile);

  return {
    name: 'registerSchemas.ts',
    content: [
      '/* eslint-disable */',
      "import { registerSchema } from 'class-validator'",
      `export enum ValidationSchemas {${validationSchemas
        .map(
          (validationSchema) =>
            `${validationSchema.name} = "${validationSchema.name}"`
        )
        .join(',')}}`,
      validationSchemas
        .map(
          (validationSchema) =>
            `registerSchema({
            name: "${validationSchema.name}",
            properties: {
              ${Object.entries(validationSchema.properties).map(
                ([property, validators]) => `
                ${property}: [
                  ${validators.map(
                    (validator) => `
                    {
                      type: "${validator.type}",
                      constraints: [${validator.constraints
                        .map(emitExpression)
                        .join(',')}],
                      message: ${
                        validator.message
                          ? emitExpression(validator.message)
                          : 'undefined'
                      },
                      each: ${
                        validator.each
                          ? emitExpression(validator.each)
                          : 'undefined'
                      },
                      always: ${
                        validator.always
                          ? emitExpression(validator.always)
                          : 'undefined'
                      },
                      groups: ${
                        validator.groups
                          ? emitExpression(validator.groups)
                          : '[]'
                      }
                    }
                  `
                  )}
                ]
              `
              )}
            }
          })`
        )
        .join('\n'),
    ].join('\n'),
  };
};

const formatContent = (content: string) => {
  return prettier.format(content, {
    semi: false,
    parser: 'typescript',
    trailingComma: 'none',
  });
};

const writeFileToDisc = (file: File) => {
  fs.writeFileSync(path.join(dist, file.name), formatContent(file.content), {
    flag: 'w',
  });
};

const validationShemas = getFileNames()
  .map(loadFile)
  .map(createSourceFile)
  .reduce<ValidationSchema[]>(
    (acc, sourceFile) => [...acc, ...processSourceFile(sourceFile)],
    []
  );

writeFileToDisc(emitSchemasFile(validationShemas));
