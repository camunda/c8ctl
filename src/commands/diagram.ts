/**
 * Process instance diagram generation
 *
 * Renders a BPMN diagram with highlighted elements and sequence flows
 * for a process instance, outputting a PNG image.
 * Uses puppeteer-core with system-installed Chrome/Chromium and bundled bpmn-js assets.
 *
 * Output behavior:
 *   --output <path>   Save PNG to specified path
 *   (no --output)     Print inline to supported terminals (iTerm2, kitty, WezTerm,
 *                     VS Code, Windows Terminal, etc.)
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Fetch process instance diagram data and render to PNG
 */
export async function getProcessInstanceDiagram(key: string, options: {
  profile?: string;
  output?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const consistencyOptions = { consistency: { waitUpToMs: 0 } };

  try {
    // 1. Get process instance to find processDefinitionKey
    logger.info('Fetching process instance data...');
    const pi = await client.getProcessInstance(
      { processInstanceKey: key as any },
      consistencyOptions
    ) as any;

    const processDefinitionKey = pi.processDefinitionKey;
    const processDefinitionId = pi.processDefinitionId;

    // 2. Fetch BPMN XML, element instances, and sequence flows in parallel
    const [xml, elementInstances, sequenceFlows] = await Promise.all([
      client.getProcessDefinitionXml(
        { processDefinitionKey: processDefinitionKey as any },
        consistencyOptions
      ),
      client.searchElementInstances(
        {
          filter: { processInstanceKey: key as any },
        },
        consistencyOptions
      ),
      client.getProcessInstanceSequenceFlows(
        { processInstanceKey: key as any },
        consistencyOptions
      ),
    ]);

    // 3. Extract completed element IDs (exclude PROCESS type)
    const completedElements = [...new Set(
      ((elementInstances as any).items || [])
        .filter((el: any) =>
          el.type !== 'PROCESS' &&
          (el.state === 'COMPLETED' || el.state === 'TERMINATED')
        )
        .map((el: any) => el.elementId)
    )];

    // 4. Extract active element IDs
    const activeElements = [...new Set(
      ((elementInstances as any).items || [])
        .filter((el: any) => el.type !== 'PROCESS' && el.state === 'ACTIVE')
        .map((el: any) => el.elementId)
    )];

    // 5. Extract incident element IDs
    const incidentElements = [...new Set(
      ((elementInstances as any).items || [])
        .filter((el: any) => el.hasIncident === true)
        .map((el: any) => el.elementId)
    )];

    // 6. Extract taken sequence flow IDs
    const takenSequenceFlows = [...new Set(
      ((sequenceFlows as any).items || [])
        .map((sf: any) => sf.elementId)
    )];

    // 7. Render to PNG buffer
    logger.info('Rendering diagram...');
    const pngBuffer = await renderDiagramToPng({
      processInstanceKey: key,
      processDefinitionId,
      processDefinitionKey,
      state: pi.state,
      xml: xml as string,
      completedElements: completedElements as string[],
      activeElements: activeElements as string[],
      incidentElements: incidentElements as string[],
      takenSequenceFlows: takenSequenceFlows as string[],
    });

    // 8. Output: save to file if --output, otherwise print inline
    if (options.output) {
      writeFileSync(options.output, pngBuffer);
      logger.success(`Diagram saved to ${options.output}`);
    } else {
      printInlineImage(pngBuffer, `c8-diagram-${key}.png`);
    }

  } catch (error) {
    logger.error(`Failed to generate diagram for process instance ${key}`, error as Error);
    process.exit(1);
  }
}

interface DiagramData {
  processInstanceKey: string;
  processDefinitionId: string;
  processDefinitionKey: string | number;
  state: string;
  xml: string;
  completedElements: string[];
  activeElements: string[];
  incidentElements: string[];
  takenSequenceFlows: string[];
}

/**
 * Find system-installed Chrome/Chromium executable
 */
async function findChromePath(): Promise<string> {
  const { computeSystemExecutablePath, Browser, ChromeReleaseChannel } =
    await import('@puppeteer/browsers');

  const candidates: Array<{ browser: typeof Browser[keyof typeof Browser]; channel: typeof ChromeReleaseChannel[keyof typeof ChromeReleaseChannel] }> = [
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
    'Install Google Chrome or Chromium to use --diagram.\n' +
    'Download: https://www.google.com/chrome/'
  );
}

/**
 * Render BPMN diagram to PNG buffer using headless Chrome
 */
async function renderDiagramToPng(data: DiagramData): Promise<Buffer> {
  const puppeteer = await import('puppeteer-core');
  const chromePath = await findChromePath();

  const browser = await puppeteer.default.launch({
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const html = generateDiagramHtml(data);
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Wait for bpmn-js to finish rendering
    await page.waitForFunction(
      'window.__diagramRendered === true',
      { timeout: 15000 },
    );

    // Get the bounding box of the rendered diagram for tight cropping
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

    await page.setViewport({
      width: (clip as any) ? Math.ceil((clip as any).x + (clip as any).width) : 1920,
      height: (clip as any) ? Math.ceil((clip as any).y + (clip as any).height) : 1080,
      deviceScaleFactor: 2,
    });

    // Re-render after viewport change
    await page.evaluate('window.__viewer && window.__viewer.get("canvas").zoom("fit-viewport")');

    // Brief wait for re-render
    await new Promise(resolve => setTimeout(resolve, 200));

    // Recalculate clip after re-render
    const finalClip = await page.evaluate(`(function() {
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
      clip: (finalClip as any) || undefined,
      omitBackground: false,
    });

    return Buffer.from(screenshot);
  } finally {
    await browser.close();
  }
}

/**
 * Print a PNG image inline in the terminal using the iTerm2 Inline Images Protocol.
 * Supported by: iTerm2, WezTerm, mintty, VS Code, Konsole, kitty (compat mode), and others.
 */
function printInlineImage(pngBuffer: Buffer, filename: string): void {
  const base64 = pngBuffer.toString('base64');
  const args = `name=${Buffer.from(filename).toString('base64')};size=${pngBuffer.length};inline=1`;

  // iTerm2 Inline Images Protocol: OSC 1337 ; File=[args] : <base64> ST
  process.stdout.write(`\x1b]1337;File=${args}:${base64}\x07\n`);
}

/**
 * Generate HTML for headless rendering (not user-facing, used as intermediate step)
 */
function generateDiagramHtml(data: DiagramData): string {
  const diagramData = JSON.stringify({
    completedElements: data.completedElements,
    activeElements: data.activeElements,
    incidentElements: data.incidentElements,
    takenSequenceFlows: data.takenSequenceFlows,
  });

  const escapedXml = JSON.stringify(data.xml);

  // Path to bundled bpmn-js assets (in dist/assets/bpmn-js/)
  const assetsDir = join(__dirname, '..', 'assets', 'bpmn-js');
  const cssPath = join(assetsDir, 'assets', 'bpmn-js.css');
  const jsPath = join(assetsDir, 'bpmn-viewer.production.min.js');

  // Convert to file:// URLs for use in Puppeteer
  const cssUrl = `file://${cssPath.replace(/\\/g, '/')}`;
  const jsUrl = `file://${jsPath.replace(/\\/g, '/')}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${cssUrl}">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #fff; }
    #canvas { width: 1600px; height: 900px; }

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
      const viewer = new BpmnJS({ container: '#canvas' });
      window.__viewer = viewer;

      try {
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
        console.error('Failed to render BPMN diagram:', err);
        window.__diagramRendered = true;
      }
    }

    renderDiagram();
  </script>
</body>
</html>`;
}
