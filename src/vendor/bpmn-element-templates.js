/**
 * Vendor bundle entry point for bpmn-js element template application.
 *
 * bpmn-js and bpmn-js-element-templates use extensionless ESM imports
 * internally, which Node.js cannot resolve without a bundler. This file
 * is bundled with esbuild into a single self-contained CJS module that
 * can be require()'d at runtime.
 *
 * Build: npm run build:vendor
 */

import Modeler from 'bpmn-js-headless/lib/Modeler';
import { CloudElementTemplatesCoreModule } from 'bpmn-js-element-templates/core';
import ZeebeModdleExtension from 'zeebe-bpmn-moddle/resources/zeebe.json';

export { Modeler, CloudElementTemplatesCoreModule, ZeebeModdleExtension };
