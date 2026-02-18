/**
 * Process instance diagram generation
 * 
 * Generates a self-contained HTML file that renders a BPMN diagram with
 * highlighted elements and sequence flows for a process instance.
 * Uses bpmn-js loaded from CDN for client-side rendering.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';

/**
 * Fetch process instance diagram data and generate an HTML file
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
        .filter((el: any) => el.type !== 'PROCESS')
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

    // 7. Generate HTML
    const html = generateDiagramHtml({
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

    // 8. Write to file and open
    const outputPath = options.output || join(tmpdir(), `c8-diagram-${key}.html`);
    writeFileSync(outputPath, html, 'utf-8');
    logger.success(`Diagram saved to ${outputPath}`);

    // Open in default browser
    await openInBrowser(outputPath);

  } catch (error) {
    logger.error(`Failed to generate diagram for process instance ${key}`, error as Error);
    process.exit(1);
  }
}

/**
 * Open a file in the default browser (cross-platform)
 */
async function openInBrowser(filePath: string): Promise<void> {
  const { exec } = await import('node:child_process');
  const url = `file://${filePath}`;

  const platform = process.platform;
  let cmd: string;

  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'linux') {
    // WSL detection
    const isWSL = process.env.WSL_DISTRO_NAME || process.env.WSLENV;
    cmd = isWSL ? `wslview "${url}" || xdg-open "${url}"` : `xdg-open "${url}"`;
  } else {
    // Should not happen (no native Windows support, only WSL)
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (error) => {
    if (error) {
      const logger = getLogger();
      logger.info(`Open the diagram in your browser: ${url}`);
    }
  });
}

/**
 * Generate a self-contained HTML file with embedded bpmn-js viewer
 */
function generateDiagramHtml(data: {
  processInstanceKey: string;
  processDefinitionId: string;
  processDefinitionKey: string | number;
  state: string;
  xml: string;
  completedElements: string[];
  activeElements: string[];
  incidentElements: string[];
  takenSequenceFlows: string[];
}): string {
  const diagramData = JSON.stringify({
    processInstanceKey: data.processInstanceKey,
    processDefinitionId: data.processDefinitionId,
    processDefinitionKey: data.processDefinitionKey,
    state: data.state,
    completedElements: data.completedElements,
    activeElements: data.activeElements,
    incidentElements: data.incidentElements,
    takenSequenceFlows: data.takenSequenceFlows,
  });

  // Escape XML for embedding in script tag
  const escapedXml = JSON.stringify(data.xml);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Process Instance ${data.processInstanceKey} - ${data.processDefinitionId}</title>
  <link rel="stylesheet" href="https://unpkg.com/bpmn-js@18/dist/assets/bpmn-js.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; }
    .header {
      background: #1a1a2e; color: #fff; padding: 16px 24px;
      display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header .meta { font-size: 13px; color: #a0a0b0; }
    .header .state {
      display: inline-block; padding: 2px 10px; border-radius: 12px;
      font-size: 12px; font-weight: 600; text-transform: uppercase;
    }
    .state-ACTIVE { background: #0d6efd; color: #fff; }
    .state-COMPLETED { background: #198754; color: #fff; }
    .state-CANCELED { background: #6c757d; color: #fff; }
    .state-INCIDENT { background: #dc3545; color: #fff; }
    .legend {
      display: flex; gap: 20px; padding: 10px 24px; background: #fff;
      border-bottom: 1px solid #dee2e6; font-size: 13px; color: #555; flex-wrap: wrap;
    }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-color {
      width: 16px; height: 16px; border-radius: 3px; border: 2px solid;
    }
    .legend-completed { border-color: #0072CE; background: rgba(0, 114, 206, 0.1); }
    .legend-active { border-color: #0d6efd; background: rgba(13, 110, 253, 0.3); animation: pulse 2s infinite; }
    .legend-incident { border-color: #dc3545; background: rgba(220, 53, 69, 0.15); }
    .legend-flow { border-color: #0072CE; background: #0072CE; border-radius: 0; height: 3px; width: 20px; }
    #canvas { width: 100%; height: calc(100vh - 100px); background: #fff; }

    /* BPMN element markers */
    .highlight:not(.djs-connection) .djs-visual > :nth-child(1) {
      stroke: #0072CE !important;
      fill: rgba(0, 114, 206, 0.1) !important;
    }
    .active-element:not(.djs-connection) .djs-visual > :nth-child(1) {
      stroke: #0d6efd !important;
      fill: rgba(13, 110, 253, 0.15) !important;
      animation: pulse-stroke 2s infinite;
    }
    .incident-element:not(.djs-connection) .djs-visual > :nth-child(1) {
      stroke: #dc3545 !important;
      fill: rgba(220, 53, 69, 0.1) !important;
    }
    @keyframes pulse-stroke {
      0%, 100% { stroke-width: 2px; }
      50% { stroke-width: 4px; }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${data.processDefinitionId}</h1>
    <span class="meta">Instance: ${data.processInstanceKey}</span>
    <span class="state state-${data.state}">${data.state}</span>
  </div>
  <div class="legend">
    <div class="legend-item"><div class="legend-color legend-completed"></div> Completed</div>
    <div class="legend-item"><div class="legend-color legend-active"></div> Active</div>
    <div class="legend-item"><div class="legend-color legend-incident"></div> Incident</div>
    <div class="legend-item"><div class="legend-color legend-flow"></div> Sequence Flow</div>
  </div>
  <div id="canvas"></div>

  <script src="https://unpkg.com/bpmn-js@18/dist/bpmn-viewer.production.min.js"></script>
  <script>
    const diagramData = ${diagramData};
    const xml = ${escapedXml};

    async function renderDiagram() {
      const viewer = new BpmnJS({ container: '#canvas' });

      try {
        await viewer.importXML(xml);
        const canvas = viewer.get('canvas');
        const elementRegistry = viewer.get('elementRegistry');
        const graphicsFactory = viewer.get('graphicsFactory');

        canvas.zoom('fit-viewport');

        // Highlight completed elements
        diagramData.completedElements.forEach(function(elementId) {
          canvas.addMarker(elementId, 'highlight');
        });

        // Highlight active elements (overrides completed)
        diagramData.activeElements.forEach(function(elementId) {
          canvas.addMarker(elementId, 'active-element');
        });

        // Highlight incident elements (overrides others)
        diagramData.incidentElements.forEach(function(elementId) {
          canvas.addMarker(elementId, 'incident-element');
        });

        // Color taken sequence flows
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
      } catch (err) {
        console.error('Failed to render BPMN diagram:', err);
        document.getElementById('canvas').innerHTML =
          '<div style="padding:40px;color:#dc3545;">Failed to render diagram: ' + err.message + '</div>';
      }
    }

    renderDiagram();
  </script>
</body>
</html>`;
}
