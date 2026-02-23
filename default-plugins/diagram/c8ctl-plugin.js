/**
 * c8ctl-plugin-diagram
 *
 * Renders BPMN diagrams for process instances as PNG images with execution
 * state highlighting (completed, active, incidents, sequence flows).
 *
 * Uses puppeteer-core with system-installed Chrome/Chromium and bundled
 * bpmn-js assets. Can be carved out into a standalone npm package.
 *
 * Usage:
 *   c8ctl diagram <processInstanceKey>
 *   c8ctl diagram <processInstanceKey> --output ./diagram.png
 *   c8ctl diagram <processInstanceKey> --profile myprofile
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const metadata = {
  name: 'diagram',
  description: 'Render process instance BPMN diagram as PNG with execution highlights',
  commands: {
    diagram: {
      description: 'Render process instance diagram as PNG with execution highlights',
    },
  },
};

export const commands = {
  diagram: async (args) => {
    // Parse flags from process.argv (plugin receives only positional args)
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        output: { type: 'string' },
        profile: { type: 'string' },
      },
      allowPositionals: true,
      strict: false,
    });

    // args[0] is the process instance key (second positional after 'diagram')
    const key = args[0];
    if (!key) {
      console.error('✗ Process instance key required. Usage: c8ctl diagram <key> [--output <path>]');
      process.exit(1);
    }

    await getProcessInstanceDiagram(key, {
      profile: values.profile,
      output: values.output,
    });
  },
};

/**
 * Fetch process instance diagram data and render to PNG
 */
async function getProcessInstanceDiagram(key, options) {
  const client = globalThis.c8ctl?.createClient(options.profile);
  if (!client) {
    console.error('✗ No Camunda client available. Ensure c8ctl is properly configured.');
    process.exit(1);
  }

  const consistencyOptions = { consistency: { waitUpToMs: 0 } };

  try {
    // 1. Get process instance to find processDefinitionKey
    const pi = await client.getProcessInstance(
      { processInstanceKey: key },
      consistencyOptions
    );

    const processDefinitionKey = pi.processDefinitionKey;
    const processDefinitionId = pi.processDefinitionId;

    // 2. Fetch BPMN XML, element instances, and sequence flows in parallel
    const [xml, elementInstances, sequenceFlows] = await Promise.all([
      client.getProcessDefinitionXml(
        { processDefinitionKey },
        consistencyOptions
      ),
      client.searchElementInstances(
        { filter: { processInstanceKey: key } },
        consistencyOptions
      ),
      client.getProcessInstanceSequenceFlows(
        { processInstanceKey: key },
        consistencyOptions
      ),
    ]);

    // 3. Extract completed element IDs (terminal states only, exclude PROCESS)
    const completedElements = [...new Set(
      (elementInstances?.items || [])
        .filter((el) =>
          el.type !== 'PROCESS' &&
          (el.state === 'COMPLETED' || el.state === 'TERMINATED')
        )
        .map((el) => el.elementId)
    )];

    // 4. Extract active element IDs
    const activeElements = [...new Set(
      (elementInstances?.items || [])
        .filter((el) => el.type !== 'PROCESS' && el.state === 'ACTIVE')
        .map((el) => el.elementId)
    )];

    // 5. Extract incident element IDs
    const incidentElements = [...new Set(
      (elementInstances?.items || [])
        .filter((el) => el.hasIncident === true)
        .map((el) => el.elementId)
    )];

    // 6. Extract taken sequence flow IDs
    const takenSequenceFlows = [...new Set(
      (sequenceFlows?.items || [])
        .map((sf) => sf.elementId)
    )];

    // 7. Render to PNG buffer
    const pngBuffer = await renderDiagramToPng({
      processInstanceKey: key,
      processDefinitionId,
      processDefinitionKey,
      state: pi.state,
      xml,
      completedElements,
      activeElements,
      incidentElements,
      takenSequenceFlows,
    });

    // 8. Output: save to file or print inline
    if (options.output) {
      try {
        const parentDir = dirname(options.output);
        mkdirSync(parentDir, { recursive: true });
        writeFileSync(options.output, pngBuffer);
        console.error(`✓ Diagram saved to ${options.output}`);
      } catch (fsError) {
        if (fsError.code === 'EACCES') {
          console.error(`✗ Permission denied writing to ${options.output}. Check file permissions.`);
        } else if (fsError.code === 'ENOSPC') {
          console.error(`✗ No space left on device when writing to ${options.output}.`);
        } else if (fsError.code === 'EROFS') {
          console.error(`✗ Cannot write to ${options.output}: read-only file system.`);
        } else {
          console.error(`✗ Failed to write diagram to ${options.output}: ${fsError.message}`);
        }
        process.exit(1);
      }
    } else {
      await printInlineImage(pngBuffer, `c8-diagram-${key}.png`);
    }
  } catch (error) {
    console.error(`✗ Failed to generate diagram for process instance ${key}: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Find the bpmn-js assets directory.
 * Probes for both production (dist/assets/bpmn-js) and dev (node_modules/bpmn-js/dist) paths.
 */
function findBpmnJsAssetsDir() {
  // Production path: dist/default-plugins/diagram/ -> ../../assets/bpmn-js/
  const prodPath = join(__dirname, '..', '..', 'assets', 'bpmn-js');
  if (existsSync(join(prodPath, 'bpmn-viewer.production.min.js'))) {
    return prodPath;
  }

  // Development path: default-plugins/diagram/ -> ../../node_modules/bpmn-js/dist/
  const devPath = join(__dirname, '..', '..', 'node_modules', 'bpmn-js', 'dist');
  if (existsSync(join(devPath, 'bpmn-viewer.production.min.js'))) {
    return devPath;
  }

  throw new Error(
    'bpmn-js assets not found.\n' +
    'Run "npm run build" to bundle the assets, or install bpmn-js: npm install bpmn-js'
  );
}

/**
 * Find system-installed Chrome/Chromium executable
 */
async function findChromePath() {
  const { computeSystemExecutablePath, Browser, ChromeReleaseChannel } =
    await import('@puppeteer/browsers');

  const candidates = [
    { browser: Browser.CHROME, channel: ChromeReleaseChannel.STABLE },
    { browser: Browser.CHROME, channel: ChromeReleaseChannel.DEV },
    { browser: Browser.CHROME, channel: ChromeReleaseChannel.BETA },
    { browser: Browser.CHROMIUM, channel: ChromeReleaseChannel.STABLE },
  ];

  for (const { browser, channel } of candidates) {
    try {
      return computeSystemExecutablePath({ browser, channel });
    } catch {
      // try next
    }
  }

  throw new Error(
    'No Chrome or Chromium browser found.\n' +
    'Install Google Chrome or Chromium to use the diagram command.\n' +
    'Download: https://www.google.com/chrome/'
  );
}

/**
 * Render BPMN diagram to PNG buffer using headless Chrome and bpmn-js
 */
async function renderDiagramToPng(data) {
  const puppeteer = await import('puppeteer-core');
  const chromePath = await findChromePath();

  const browser = await puppeteer.default.launch({
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Use a large viewport so the entire diagram fits
    await page.setViewport({ width: 4000, height: 4000, deviceScaleFactor: 2 });

    const html = generateDiagramHtml(data);
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Wait for bpmn-js to finish rendering
    await page.waitForFunction(
      'window.__diagramRendered === true',
      { timeout: 15000 }
    );

    // Check for rendering errors propagated from the browser
    const diagramError = await page.evaluate('window.__diagramError');
    if (diagramError) {
      throw new Error(`BPMN rendering failed: ${diagramError}`);
    }

    // Zoom to fit-viewport (synchronous in bpmn-js)
    await page.evaluate('window.__viewer && window.__viewer.get("canvas").zoom("fit-viewport")');

    // Calculate bounding box of the rendered diagram for tight cropping
    const clip = await page.evaluate(`(function() {
      var svg = document.querySelector('#canvas svg');
      if (!svg) return null;
      var bbox = svg.getBBox();
      var ctm = svg.getScreenCTM();
      if (!ctm) return null;
      return {
        x: Math.max(0, bbox.x * ctm.a + ctm.e - 20),
        y: Math.max(0, bbox.y * ctm.d + ctm.f - 20),
        width: bbox.width * ctm.a + 40,
        height: bbox.height * ctm.d + 40,
      };
    })()`);

    const screenshot = await page.screenshot({
      type: 'png',
      clip: clip || undefined,
      omitBackground: false,
    });

    return Buffer.from(screenshot);
  } finally {
    await browser.close();
  }
}

/**
 * Generate HTML page for headless rendering.
 * Uses locally bundled bpmn-js assets (no CDN dependency).
 */
function generateDiagramHtml(data) {
  const diagramData = JSON.stringify({
    completedElements: data.completedElements,
    activeElements: data.activeElements,
    incidentElements: data.incidentElements,
    takenSequenceFlows: data.takenSequenceFlows,
  });

  const escapedXml = JSON.stringify(data.xml);

  const assetsDir = findBpmnJsAssetsDir();

  // Use pathToFileURL for correct cross-platform file:// URLs
  const cssUrl = pathToFileURL(join(assetsDir, 'assets', 'bpmn-js.css')).href;
  const jsUrl = pathToFileURL(join(assetsDir, 'bpmn-viewer.production.min.js')).href;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${cssUrl}">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #fff; }
    #canvas { width: 3800px; height: 3800px; }

    .highlight:not(.djs-connection) .djs-visual > :nth-child(1) {
      stroke: #0072CE !important;
      fill: rgba(0, 114, 206, 0.1) !important;
    }
    .active-element:not(.djs-connection) .djs-visual > :nth-child(1) {
      stroke: #0d6efd !important;
      fill: rgba(13, 110, 253, 0.15) !important;
    }
    .incident-element:not(.djs-connection) .djs-visual > :nth-child(1) {
      stroke: #dc3545 !important;
      fill: rgba(220, 53, 69, 0.1) !important;
    }
  </style>
</head>
<body>
  <div id="canvas"></div>

  <script src="${jsUrl}"></script>
  <script>
    const diagramData = ${diagramData};
    const xml = ${escapedXml};

    async function renderDiagram() {
      try {
        const viewer = new BpmnJS({ container: '#canvas' });
        window.__viewer = viewer;

        await viewer.importXML(xml);
        const canvas = viewer.get('canvas');
        const elementRegistry = viewer.get('elementRegistry');
        const graphicsFactory = viewer.get('graphicsFactory');

        canvas.zoom('fit-viewport');

        diagramData.completedElements.forEach(function(elementId) {
          canvas.addMarker(elementId, 'highlight');
        });

        diagramData.activeElements.forEach(function(elementId) {
          canvas.addMarker(elementId, 'active-element');
        });

        diagramData.incidentElements.forEach(function(elementId) {
          canvas.addMarker(elementId, 'incident-element');
        });

        diagramData.takenSequenceFlows.forEach(function(flowId) {
          var sequenceFlow = elementRegistry.get(flowId);
          if (sequenceFlow) {
            var gfx = elementRegistry.getGraphics(sequenceFlow);
            if (gfx && sequenceFlow.businessObject && sequenceFlow.businessObject.di) {
              var di = sequenceFlow.businessObject.di;
              di.set('stroke', '#0072CE');
              di.set('fill', '#0072CE');
              graphicsFactory.update('connection', sequenceFlow, gfx);
            }
          }
        });

        window.__diagramRendered = true;
      } catch (err) {
        window.__diagramError = err && err.message ? err.message : String(err);
        window.__diagramRendered = true;
      }
    }

    renderDiagram();
  </script>
</body>
</html>`;
}

/**
 * Print a PNG image inline in the terminal using the best available protocol.
 * Supports Kitty Graphics Protocol, iTerm2 Inline Images Protocol, and Sixel.
 */
async function printInlineImage(pngBuffer, filename) {
  const supportsTerminalGraphics = (await import('supports-terminal-graphics')).default;
  const support = supportsTerminalGraphics.stdout;

  if (support.kitty) {
    printKittyImage(pngBuffer);
  } else if (support.iterm2) {
    printIterm2Image(pngBuffer, filename);
  } else if (support.sixel) {
    await printSixelImage(pngBuffer);
  } else {
    // Fallback: try iTerm2 protocol (works in WezTerm, mintty, VS Code, etc.)
    printIterm2Image(pngBuffer, filename);
  }
}

/**
 * Print image using Kitty Graphics Protocol (Ghostty, Kitty, WezTerm, Konsole)
 */
function printKittyImage(pngBuffer) {
  const base64 = pngBuffer.toString('base64');
  const chunkSize = 4096;

  for (let i = 0; i < base64.length; i += chunkSize) {
    const chunk = base64.slice(i, i + chunkSize);
    const isLast = (i + chunkSize) >= base64.length;
    const moreFlag = isLast ? 0 : 1;
    const action = (i === 0) ? 'a=T,f=100' : '';
    const params = action ? `${action},m=${moreFlag}` : `m=${moreFlag}`;

    process.stdout.write(`\x1b_G${params};${chunk}\x1b\\`);
  }
  process.stdout.write('\n');
}

/**
 * Print image using iTerm2 Inline Images Protocol (iTerm2, WezTerm, mintty, VS Code)
 */
function printIterm2Image(pngBuffer, filename) {
  const base64 = pngBuffer.toString('base64');
  const args = `name=${Buffer.from(filename).toString('base64')};size=${pngBuffer.length};inline=1`;
  process.stdout.write(`\x1b]1337;File=${args}:${base64}\x07\n`);
}

/**
 * Print image using Sixel protocol (xterm, mintty, mlterm)
 */
async function printSixelImage(pngBuffer) {
  const { image2sixel } = await import('sixel');
  const { PNG } = await import('pngjs');

  const png = PNG.sync.read(pngBuffer);
  const sixelData = image2sixel(png.data, png.width, png.height, 256, 0);

  process.stdout.write(sixelData);
  process.stdout.write('\n');
}
