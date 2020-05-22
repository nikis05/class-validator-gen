import * as ts from 'typescript';
import glob from 'glob';
import path from 'path';
import fs from 'fs';
import { ValidationSchema } from 'class-validator';

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

const getFileNames = (): string[] => glob.sync(source_glob, { cwd: base, absolute: true });

interface File {
    name: string;
    content: string;
}

const loadFile = (fileName: string): File => ({
    name: fileName,
    content: fs.readFileSync(fileName).toString()
});

const createSourceFile = (file: File): ts.SourceFile => ts.createSourceFile(
    file.name,
    file.content,
    ts.ScriptTarget.ESNext
);

type CVDecoratorNames = Array<{
    name: string;
    alias: string;
}>

const extractCVDecoratorNames = (importDeclarations: ts.ImportDeclaration[]): CVDecoratorNames => {
    const cvImportDeclarations = importDeclarations
        .filter(importDeclaration =>
            (importDeclaration.moduleSpecifier as ts.StringLiteral).text === 'class-validator'
        );

    const cvDecoratorNames = cvImportDeclarations.reduce<CVDecoratorNames>((acc, importDeclaration) => {
        const importClause = importDeclaration.importClause;
        if (!importClause) return acc;
        const namedBindings = importClause.namedBindings;
        if (!namedBindings || namedBindings.kind !== ts.SyntaxKind.NamedImports) return acc;

        const decoratorNames = namedBindings.elements
            .map(importSpecifier => {
                const alias = importSpecifier.name.text;
                const name = (
                    importSpecifier.propertyName
                    && importSpecifier.propertyName.text
                ) || importSpecifier.name.text;
                return { name, alias };
            });
        return [...acc, ...decoratorNames];
    }, []);

    return cvDecoratorNames;
}

const isCallExpression = (
    expression: ts.LeftHandSideExpression
): expression is ts.CallExpression => {
    return expression.kind === ts.SyntaxKind.CallExpression;
}

const isIdentifier = (
    expression: ts.LeftHandSideExpression
): expression is ts.Identifier => {
    return expression.kind === ts.SyntaxKind.Identifier;
}

const decapitalize = (str: string) => str.charAt(0).toLowerCase() + str.substr(1);

const extractValidatorsFromClassElement = (
    cvDecoratorNames: CVDecoratorNames,
    classElement: ts.ClassElement
): Array<{ type: string, constraints: any[] }> => {
    if (!classElement.decorators) return [];
    return classElement.decorators
        .reduce<Array<{ type: string, constraints: any[] }>>((acc, decorator) => {
            const callExpression = decorator.expression;
            if (!isCallExpression(callExpression)) return acc;

            const identifier = callExpression.expression
            if (!isIdentifier(identifier)) return acc;

            const decoratorAlias = identifier.text;
            const cvDecoratorName = cvDecoratorNames.find(cvDecoratorName =>
                cvDecoratorName.alias === decoratorAlias
            );
            if (!cvDecoratorName) return acc;

            const constraints = callExpression.arguments.map(argument => {
                if (
                    argument.kind !== ts.SyntaxKind.StringLiteral
                    && argument.kind !== ts.SyntaxKind.NumericLiteral
                    && argument.kind !== ts.SyntaxKind.RegularExpressionLiteral
                ) throw new Error(
                    `Unsupported syntax kind in ClassValidator decorator:
                             Expected string literal, numeric literal or regex literal.`
                );
                return (argument as ts.StringLiteral).text;
            });

            return [...acc, { type: decapitalize(cvDecoratorName.name), constraints }];
        }, [])
}

const extractCVSchemaFromClass = (
    cvDecoratorNames: CVDecoratorNames,
    classDeclaration: ts.ClassDeclaration
): ValidationSchema | null => {
    const properties = classDeclaration.members
        .reduce<ValidationSchema["properties"]>((acc, classElement) => {
            if (!classElement.name || classElement.name.kind !== ts.SyntaxKind.Identifier) return acc;
            const validators = extractValidatorsFromClassElement(cvDecoratorNames, classElement);
            if (validators.length === 0) return acc;
            return { ...acc, [classElement.name.text]: validators };
        }, {});

    if (Object.keys(properties).length === 0) return null;

    if (!classDeclaration.name) return null;
    return { name: classDeclaration.name.text, properties };
}

const processSourceFile = (sourceFile: ts.SourceFile) => {
    const importDeclarations = sourceFile.statements
        .filter((statement): statement is ts.ImportDeclaration =>
            statement.kind === ts.SyntaxKind.ImportDeclaration
        );

    const cvDecoratorNames = extractCVDecoratorNames(importDeclarations);

    const classDeclarations = sourceFile.statements
        .filter((statement): statement is ts.ClassDeclaration =>
            statement.kind === ts.SyntaxKind.ClassDeclaration
        );

    const validationSchemas = classDeclarations
        .map(classDeclaration => extractCVSchemaFromClass(cvDecoratorNames, classDeclaration))
        .filter((schema): schema is ValidationSchema => schema !== null);

    return validationSchemas;
}

const emitSchemaFile = (validationShema: ValidationSchema): File => {
    return {
        name: validationShema.name + '.schema.json',
        content: JSON.stringify(validationShema)
    }
}

const emitHeaderFile = (validationShemas: ValidationSchema[]): File => {
    return {
        name: 'registerSchemas.ts',
        content: [
            "import { registerSchema } from 'class-validator'",
            validationShemas.map(validationShema =>
                `registerSchema(require("./${validationShema.name}.schema.json"))`
            )
        ].join("\n")
    }
}

const writeFileToDisc = (file: File) => {
    fs.writeFileSync(path.join(dist, file.name), file.content, { flag: 'w' });
}

const validationShemas = getFileNames()
    .map(loadFile)
    .map(createSourceFile)
    .reduce<ValidationSchema[]>((acc, sourceFile) =>
        [...acc, ...processSourceFile(sourceFile)], []
    );

const outputFiles = [
    ...validationShemas.map(validationShema => emitSchemaFile(validationShema)),
    emitHeaderFile(validationShemas)
];

outputFiles.forEach(file => writeFileToDisc(file));
