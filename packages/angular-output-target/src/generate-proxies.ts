import path from 'path';

import { OutputTargetAngular } from './types';
import { GENERATED_DTS, dashToPascalCase, readPackageJson, relativeImport, normalizePath } from './utils';

import { CompilerCtx, ComponentCompilerMeta } from '@stencil/core/internal';

export default async function generateProxies(compilerCtx: CompilerCtx, components: ComponentCompilerMeta[], outputTarget: OutputTargetAngular, rootDir: string) {
  const pkgData = await readPackageJson(rootDir);
  const distTypesDir = path.dirname(pkgData.types);
  const proxies = getProxies(components, outputTarget.componentCorePackage!, distTypesDir, rootDir);
  const dtsFilePath = path.join(rootDir, distTypesDir, GENERATED_DTS);
  const componentsTypeFile = relativeImport(outputTarget.directivesProxyFile, dtsFilePath, '.d.ts');

  const imports = `/* tslint:disable */
/* auto-generated angular directive proxies */
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, NgZone } from '@angular/core';`;

  const sourceImports = !outputTarget.componentCorePackage ?
    `import { Components } from '${normalizePath(componentsTypeFile)}';` :
    `import { Components } from '${normalizePath(outputTarget.componentCorePackage)}'`;

  const final: string[] = [
    imports,
    getProxyUtils(outputTarget),
    sourceImports,
    proxies,
  ];

  const finalText = final.join('\n') + '\n';

  return compilerCtx.fs.writeFile(outputTarget.directivesProxyFile, finalText);
}

function getProxies(components: ComponentCompilerMeta[], componentCorePackage: string, distTypesDir: string, rootDir: string) {
  return components
    .map((cmpMeta) => getProxy(cmpMeta, componentCorePackage, distTypesDir, rootDir))
    .join('\n');
}

function getProxyCmp(inputs: string[],methods: string[]): string {

  const hasInputs = inputs.length > 0;
  const hasMethods = methods.length > 0;
  const proxMeta: string[] = [];

  if (!hasInputs && !hasMethods) { return''; }

  if (hasInputs) proxMeta.push(`inputs: ['${inputs.join(`', '`)}']`);
  if (hasMethods) proxMeta.push(`'methods': ['${methods.join(`', '`)}']`);

  return `@ProxyCmp({${proxMeta.join(', ')}})`;
}

function getProxy(cmpMeta: ComponentCompilerMeta, componentCorePackage: string, distTypesDir: string, rootDir: string) {
  // Collect component meta
  const inputs = getInputs(cmpMeta);
  const outputs = getOutputs(cmpMeta);
  const methods = getMethods(cmpMeta);

  // Process meta
  const hasOutputs = outputs.length > 0;

  // Generate Angular @Directive
  const directiveOpts = [
    `selector: \'${cmpMeta.tagName}\'`,
    `changeDetection: ChangeDetectionStrategy.OnPush`,
    `template: '<ng-content></ng-content>'`
  ];
  if (inputs.length > 0) {
    directiveOpts.push(`inputs: ['${inputs.join(`', '`)}']`);
  }
  if (outputs.length > 0) {
    directiveOpts.push(`outputs: ['${outputs.map(output => output.name).join(`', '`)}']`)
  }

  const tagNameAsPascal = dashToPascalCase(cmpMeta.tagName);

  const typePath = path.parse(path.join(componentCorePackage, path.join(cmpMeta.sourceFilePath, '').replace(path.join(rootDir, 'src'), distTypesDir)))
  const importPath = normalizePath(path.join(typePath.dir, typePath.name));
  const outputsInterface =
  outputs.length > 0
    ? `import { ${cmpMeta.componentClassName} as I${cmpMeta.componentClassName} } from '${importPath}';`
    : '';

  const lines = [`${outputsInterface}
export declare interface ${tagNameAsPascal} extends Components.${tagNameAsPascal} {}
${getProxyCmp(inputs, methods)}
@Component({ ${directiveOpts.join(', ')} })
export class ${tagNameAsPascal} {`];

  // Generate outputs	
  outputs.forEach(output => {
    lines.push(`  /** ${output.docs.text} ${output.docs.tags.map(tag => `@${tag.name} ${tag.text}`)}*/`)
    lines.push(`  ${output.name}!: I${cmpMeta.componentClassName}['${output.method}'];`);	
  });

  lines.push('  protected el: HTMLElement;');
  lines.push(`  constructor(c: ChangeDetectorRef, r: ElementRef, protected z: NgZone) {
    c.detach();
    this.el = r.nativeElement;`);
  if (hasOutputs) {
    lines.push(`    proxyOutputs(this, this.el, ['${outputs.map(output => output.name).join(`', '`)}']);`);
  }
  lines.push(`  }`);
  lines.push(`}`);

  return lines.join('\n');
}

function getInputs(cmpMeta: ComponentCompilerMeta): string[] {
  return [
    ...cmpMeta.properties.filter(prop => !prop.internal).map(prop => prop.name),
    ...cmpMeta.virtualProperties.map(prop => prop.name)
  ].sort();
}

function getOutputs(cmpMeta: ComponentCompilerMeta) {
  return cmpMeta.events.filter(ev => !ev.internal).map(prop => prop);
}

function getMethods(cmpMeta: ComponentCompilerMeta): string[] {
  return cmpMeta.methods.filter(method => !method.internal).map(prop => prop.name);
}

function getProxyUtils(outputTarget: OutputTargetAngular) {
  if (!outputTarget.directivesUtilsFile) {
    return PROXY_UTILS;
  } else {
    const utilsPath = relativeImport(outputTarget.directivesProxyFile, outputTarget.directivesUtilsFile, '.ts');
    return `import { ProxyCmp, proxyOutputs } from '${normalizePath(utilsPath)}';\n`;
  }
}
const PROXY_UTILS = `import { fromEvent } from 'rxjs';

export const proxyInputs = (Cmp: any, inputs: string[]) => {
  const Prototype = Cmp.prototype;
  inputs.forEach(item => {
    Object.defineProperty(Prototype, item, {
      get() { return this.el[item]; },
      set(val: any) { this.z.runOutsideAngular(() => (this.el[item] = val)); }
    });
  });
};

export const proxyMethods = (Cmp: any, methods: string[]) => {
  const Prototype = Cmp.prototype;
  methods.forEach(methodName => {
    Prototype[methodName] = function () {
      const args = arguments;
      return this.z.runOutsideAngular(() => this.el[methodName].apply(this.el, args));
    };
  });
};

export const proxyOutputs = (instance: any, el: any, events: string[]) => {
  events.forEach(eventName => instance[eventName] = fromEvent(el, eventName));
}

// tslint:disable-next-line: only-arrow-functions
export function ProxyCmp(opts: { inputs?: any; methods?: any }) {
  const decorator =  function(cls: any){
    if (opts.inputs) {
      proxyInputs(cls, opts.inputs);
    }
    if (opts.methods) {
      proxyMethods(cls, opts.methods);
    }
    return cls;
  };
  return decorator;
}
`;
