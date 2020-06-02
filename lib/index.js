"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ts = __importStar(require("typescript"));
const glob_1 = __importDefault(require("glob"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const prettier_1 = __importDefault(require("prettier"));
const OPTION_NAMES = ['message', 'each', 'always', 'groups'];
const base_dir = process.argv[2];
const source_glob = process.argv[3];
const dist_dir = process.argv[4];
const base = path_1.default.join(process.cwd(), base_dir);
const dist = path_1.default.join(process.cwd(), dist_dir);
// Check if dist directory exist
if (!fs_1.default.existsSync(dist)) {
    // Create directory path
    fs_1.default.mkdirSync(dist, { recursive: true });
}
const getFileNames = () => glob_1.default.sync(source_glob, { cwd: base, absolute: true });
const loadFile = (fileName) => ({
    name: fileName,
    content: fs_1.default.readFileSync(fileName).toString(),
});
const createSourceFile = (file) => ts.createSourceFile(file.name, file.content, ts.ScriptTarget.ESNext);
const extractCVDecoratorNames = (importDeclarations) => {
    const cvImportDeclarations = importDeclarations.filter((importDeclaration) => importDeclaration.moduleSpecifier.text ===
        'class-validator');
    const cvDecoratorNames = cvImportDeclarations.reduce((acc, importDeclaration) => {
        const importClause = importDeclaration.importClause;
        if (!importClause)
            return acc;
        const namedBindings = importClause.namedBindings;
        if (!namedBindings || namedBindings.kind !== ts.SyntaxKind.NamedImports)
            return acc;
        const decoratorNames = namedBindings.elements.map((importSpecifier) => {
            const alias = importSpecifier.name.text;
            const name = (importSpecifier.propertyName && importSpecifier.propertyName.text) ||
                importSpecifier.name.text;
            return { name, alias };
        });
        return [...acc, ...decoratorNames];
    }, []);
    return cvDecoratorNames;
};
const decapitalize = (str) => str.charAt(0).toLowerCase() + str.substr(1);
const isOptionsArg = (expression) => {
    if (!ts.isObjectLiteralExpression(expression))
        return false;
    return expression.properties.every((property) => {
        const name = property.name;
        if (!name || !ts.isIdentifier(name))
            return false;
        return OPTION_NAMES.includes(name.text);
    });
};
const extractValidatorOptionsFromOptionsArg = (optionsArg) => {
    return optionsArg.properties.reduce((acc, property) => {
        const name = property.name;
        if (!name || !ts.isIdentifier(name))
            throw new Error('Expected option property name to be indentifier');
        if (!ts.isPropertyAssignment(property))
            throw new Error('Expected option property to be property assignment');
        const initializer = property.initializer;
        if (name.text === 'message' &&
            !ts.isStringLiteral(initializer) &&
            !ts.isArrowFunction(initializer))
            throw new Error('Expected message to be string literal or arrow function');
        if (name.text === 'each' &&
            initializer.kind !== ts.SyntaxKind.TrueKeyword &&
            initializer.kind !== ts.SyntaxKind.FalseKeyword)
            throw new Error('Expected each to be boolean literal');
        if (name.text === 'always' &&
            initializer.kind !== ts.SyntaxKind.TrueKeyword &&
            initializer.kind !== ts.SyntaxKind.FalseKeyword)
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
const validateConstraints = (args) => {
    args.forEach((arg) => {
        if (!ts.isStringLiteral(arg) &&
            !ts.isObjectLiteralExpression(arg) &&
            !ts.isRegularExpressionLiteral(arg) &&
            !ts.isNumericLiteral(arg))
            throw new Error(`Expected constraint to be a string literal,
        an object literal expression, a regular expression or a numeric literal`);
    });
};
const extractValidatorsFromClassElement = (cvDecoratorNames, classElement) => {
    if (!classElement.decorators)
        return [];
    return classElement.decorators.reduce((acc, decorator) => {
        const callExpression = decorator.expression;
        if (!ts.isCallExpression(callExpression))
            return acc;
        const identifier = callExpression.expression;
        if (!ts.isIdentifier(identifier))
            return acc;
        const decoratorAlias = identifier.text;
        const cvDecoratorName = cvDecoratorNames.find((cvDecoratorName) => cvDecoratorName.alias === decoratorAlias);
        if (!cvDecoratorName)
            return acc;
        let args = [...callExpression.arguments];
        const lastArg = args[args.length - 1];
        const optionsArg = lastArg && isOptionsArg(lastArg) ? lastArg : null;
        if (optionsArg)
            args = args.slice(0, args.length - 1);
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
const extractCVSchemaFromClass = (cvDecoratorNames, classDeclaration) => {
    const properties = classDeclaration.members.reduce((acc, classElement) => {
        if (!classElement.name ||
            classElement.name.kind !== ts.SyntaxKind.Identifier)
            return acc;
        const validators = extractValidatorsFromClassElement(cvDecoratorNames, classElement);
        if (validators.length === 0)
            return acc;
        return { ...acc, [classElement.name.text]: validators };
    }, {});
    if (Object.keys(properties).length === 0)
        return null;
    if (!classDeclaration.name)
        throw new Error('ClassValidator class declaration must be named');
    return { name: classDeclaration.name.text, properties };
};
const processSourceFile = (sourceFile) => {
    const importDeclarations = sourceFile.statements.filter(ts.isImportDeclaration);
    const cvDecoratorNames = extractCVDecoratorNames(importDeclarations);
    const classDeclarations = sourceFile.statements.filter((statement) => statement.kind === ts.SyntaxKind.ClassDeclaration);
    const validationSchemas = classDeclarations
        .map((classDeclaration) => extractCVSchemaFromClass(cvDecoratorNames, classDeclaration))
        .filter((schema) => schema !== null);
    return validationSchemas;
};
const emitSchemasFile = (validationSchemas) => {
    const sourceFile = ts.createSourceFile('registerSchemas.ts', '', ts.ScriptTarget.ESNext);
    const printer = ts.createPrinter();
    const emitExpression = (node) => printer.printNode(ts.EmitHint.Expression, node, sourceFile);
    return {
        name: 'registerSchemas.ts',
        content: [
            "import { registerSchema } from 'class-validator'",
            `export type TValidationSchemas = ${validationSchemas
                .map((validationSchema) => `"${validationSchema.name}"`)
                .join(' | ')}`,
            validationSchemas.map((validationSchema) => `registerSchema({
            name: "${validationSchema.name}",
            properties: {
              ${Object.entries(validationSchema.properties).map(([property, validators]) => `
                ${property}: [
                  ${validators.map((validator) => `
                    {
                      type: "${validator.type}",
                      constraints: [${validator.constraints
                .map(emitExpression)
                .join(',')}],
                      message: ${validator.message
                ? emitExpression(validator.message)
                : 'undefined'},
                      each: ${validator.each
                ? emitExpression(validator.each)
                : 'undefined'},
                      always: ${validator.always
                ? emitExpression(validator.always)
                : 'undefined'},
                      groups: ${validator.groups
                ? emitExpression(validator.groups)
                : '[]'}
                    },
                  `)}
                ]
              `)}
            }
          })`),
        ].join('\n'),
    };
};
const formatContent = (content) => {
    return prettier_1.default.format(content, {
        semi: false,
        parser: 'typescript',
        trailingComma: 'none',
    });
};
const writeFileToDisc = (file) => {
    fs_1.default.writeFileSync(path_1.default.join(dist, file.name), formatContent(file.content), {
        flag: 'w',
    });
};
const validationShemas = getFileNames()
    .map(loadFile)
    .map(createSourceFile)
    .reduce((acc, sourceFile) => [...acc, ...processSourceFile(sourceFile)], []);
writeFileToDisc(emitSchemasFile(validationShemas));
