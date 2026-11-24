/**
 * Vendor bundle entry point for the element-template plugin.
 *
 * bpmn-js and bpmn-js-element-templates use extensionless ESM imports
 * internally, which Node.js cannot resolve without a bundler. This file
 * is bundled with esbuild into a single self-contained CJS module that
 * is loaded at runtime by the plugin via require().
 *
 * Build: npm run build:vendor
 */

import Modeler from 'bpmn-js-headless/lib/Modeler';
import { CloudElementTemplatesCoreModule } from 'bpmn-js-element-templates/core';
import ZeebeModdleExtension from 'zeebe-bpmn-moddle/resources/zeebe.json';

/**
 * No-op TextRenderer module.
 *
 * bpmn-js's BpmnImporter.addLabel calls textRenderer.getExternalLabelBounds
 * to fit external labels (event/gateway names). The default implementation
 * creates an SVG <text> via document.createElementNS to measure dimensions
 * — which throws in Node.js where `document` doesn't exist. The errors are
 * non-fatal (the importer catches them) but produce noisy stack traces.
 *
 * For template application we don't need accurate label measurements:
 * the input file's existing BPMNLabel bounds are preserved on saveXML.
 * Returning the input bounds unchanged keeps the importer happy without
 * touching the DOM.
 */
const HeadlessTextRendererModule = {
  textRenderer: ['type', function HeadlessTextRenderer() {
    this.getExternalLabelBounds = function(bounds) { return bounds; };
    this.getTextAnnotationBounds = function(bounds) { return bounds; };
    this.getDimensions = function() { return { width: 0, height: 0 }; };
    this.createText = function() { return null; };
  }],
};

export {
  Modeler,
  CloudElementTemplatesCoreModule,
  ZeebeModdleExtension,
  HeadlessTextRendererModule,
};
