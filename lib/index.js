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
const base_dir = process.argv[2];
const source_glob = process.argv[3];
const dist_dir = process.argv[4];
const base = path_1.default.join(process.cwd(), base_dir);
const dist = path_1.default.join(process.cwd(), dist_dir);
const getFileNames = () => glob_1.default.sync(source_glob, { cwd: base, absolute: true });
const loadFile = (fileName) => ({
    name: fileName,
    content: fs_1.default.readFileSync(fileName).toString()
});
const createSourceFile = (file) => ts.createSourceFile(file.name, file.content, ts.ScriptTarget.ESNext);
const extractCVDecoratorNames = (importDeclarations) => {
    const cvImportDeclarations = importDeclarations
        .filter(importDeclaration => importDeclaration.moduleSpecifier.text === 'class-validator');
    const cvDecoratorNames = cvImportDeclarations.reduce((acc, importDeclaration) => {
        const importClause = importDeclaration.importClause;
        if (!importClause)
            return acc;
        const namedBindings = importClause.namedBindings;
        if (!namedBindings || namedBindings.kind !== ts.SyntaxKind.NamedImports)
            return acc;
        const decoratorNames = namedBindings.elements
            .map(importSpecifier => {
            const alias = importSpecifier.name.text;
            const name = (importSpecifier.propertyName
                && importSpecifier.propertyName.text) || importSpecifier.name.text;
            return { name, alias };
        });
        return [...acc, ...decoratorNames];
    }, []);
    return cvDecoratorNames;
};
const isCallExpression = (expression) => {
    return expression.kind === ts.SyntaxKind.CallExpression;
};
const isIdentifier = (expression) => {
    return expression.kind === ts.SyntaxKind.Identifier;
};
const decapitalize = (str) => str.charAt(0).toLowerCase() + str.substr(1);
const extractValidatorsFromClassElement = (cvDecoratorNames, classElement) => {
    if (!classElement.decorators)
        return [];
    return classElement.decorators
        .reduce((acc, decorator) => {
        const callExpression = decorator.expression;
        if (!isCallExpression(callExpression))
            return acc;
        const identifier = callExpression.expression;
        if (!isIdentifier(identifier))
            return acc;
        const decoratorAlias = identifier.text;
        const cvDecoratorName = cvDecoratorNames.find(cvDecoratorName => cvDecoratorName.alias === decoratorAlias);
        if (!cvDecoratorName)
            return acc;
        const constraints = callExpression.arguments.map(argument => {
            if (argument.kind !== ts.SyntaxKind.StringLiteral
                && argument.kind !== ts.SyntaxKind.NumericLiteral
                && argument.kind !== ts.SyntaxKind.RegularExpressionLiteral)
                throw new Error(`Unsupported syntax kind in ClassValidator decorator:
                             Expected string literal, numeric literal or regex literal.`);
            return argument.text;
        });
        return [...acc, { type: decapitalize(cvDecoratorName.name), constraints }];
    }, []);
};
const extractCVSchemaFromClass = (cvDecoratorNames, classDeclaration) => {
    const properties = classDeclaration.members
        .reduce((acc, classElement) => {
        if (!classElement.name || classElement.name.kind !== ts.SyntaxKind.Identifier)
            return acc;
        const validators = extractValidatorsFromClassElement(cvDecoratorNames, classElement);
        if (validators.length === 0)
            return acc;
        return { ...acc, [classElement.name.text]: validators };
    }, {});
    if (Object.keys(properties).length === 0)
        return null;
    if (!classDeclaration.name)
        return null;
    return { name: classDeclaration.name.text, properties };
};
const processSourceFile = (sourceFile) => {
    const importDeclarations = sourceFile.statements
        .filter((statement) => statement.kind === ts.SyntaxKind.ImportDeclaration);
    const cvDecoratorNames = extractCVDecoratorNames(importDeclarations);
    const classDeclarations = sourceFile.statements
        .filter((statement) => statement.kind === ts.SyntaxKind.ClassDeclaration);
    const validationSchemas = classDeclarations
        .map(classDeclaration => extractCVSchemaFromClass(cvDecoratorNames, classDeclaration))
        .filter((schema) => schema !== null);
    return validationSchemas;
};
const emitSchemaFile = (validationShema) => {
    return {
        name: validationShema.name + '.schema.json',
        content: JSON.stringify(validationShema)
    };
};
const emitHeaderFile = (validationShemas) => {
    return {
        name: 'registerSchemas.ts',
        content: [
            "import { registerSchema } from 'class-validator'",
            validationShemas.map(validationShema => `registerSchema(require("./${validationShema.name}.schema.json"))`)
        ].join("\n")
    };
};
const writeFileToDisc = (file) => {
    fs_1.default.writeFileSync(path_1.default.join(dist, file.name), file.content, { flag: 'w' });
};
const validationShemas = getFileNames()
    .map(loadFile)
    .map(createSourceFile)
    .reduce((acc, sourceFile) => [...acc, ...processSourceFile(sourceFile)], []);
const outputFiles = [
    ...validationShemas.map(validationShema => emitSchemaFile(validationShema)),
    emitHeaderFile(validationShemas)
];
outputFiles.forEach(file => writeFileToDisc(file));
