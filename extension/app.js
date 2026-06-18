(function () {
  const AGENT_ENDPOINT = 'http://localhost:8766/tableau-agent-filter';

  const DEFAULT_FILTER = {
    fieldName: 'driver_name',
    values: ['Lewis Hamilton'],
    targetWorksheetNames: [
      'Driver Wins',
      'Constructor Wins',
      'Race Results'
    ]
  };

  const els = {
    agentAnswer: document.querySelector('#agentAnswer'),
    answerPanel: document.querySelector('#answerPanel'),
    agentPrompt: document.querySelector('#agentPrompt'),
    applyLastFilter: document.querySelector('#applyLastFilter'),
    askAgent: document.querySelector('#askAgent'),
    clearFilter: document.querySelector('#clearFilter'),
    statusDot: document.querySelector('#statusDot'),
    statusText: document.querySelector('#statusText')
  };

  let dashboard;
  let currentFilters = [DEFAULT_FILTER];

  function setStatus(message, state) {
    els.statusText.textContent = message;
    els.statusDot.dataset.state = state;
  }

  function setCurrentFilters(filterInstructions) {
    currentFilters = filterInstructions.map((filterInstruction) => {
      return {
        fieldName: filterInstruction.fieldName,
        values: filterInstruction.values,
        applyToAllWorksheets: filterInstruction.applyToAllWorksheets,
        targetWorksheetNames: filterInstruction.targetWorksheetNames || DEFAULT_FILTER.targetWorksheetNames
      };
    });

    els.applyLastFilter.disabled = !dashboard;
  }

  function setAgentAnswer(answer) {
    const normalizedAnswer = String(answer || '').trim();
    els.agentAnswer.textContent = normalizedAnswer;
    els.answerPanel.hidden = !normalizedAnswer;
  }

  function getTargetWorksheets(filterInstruction) {
    const worksheets = dashboard.worksheets || [];

    if (filterInstruction.applyToAllWorksheets) {
      return worksheets;
    }

    const requestedNames = filterInstruction.targetWorksheetNames || [];
    const matches = worksheets.filter((worksheet) => requestedNames.includes(worksheet.name));
    return matches.length > 0 ? matches : worksheets;
  }

  function parseJsonFromText(text) {
    const trimmed = text.trim();

    if (!trimmed) {
      throw new Error('Agent response was empty.');
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        throw error;
      }

      return JSON.parse(jsonMatch[0]);
    }
  }

  function unwrapAgentResponse(rawInstruction) {
    if (typeof rawInstruction === 'string') {
      return parseJsonFromText(rawInstruction);
    }

    if (!rawInstruction || typeof rawInstruction !== 'object') {
      return rawInstruction;
    }

    if (Array.isArray(rawInstruction.filters) && rawInstruction.filters.length > 0) {
      return rawInstruction.filters;
    }

    if (rawInstruction.filter) {
      return rawInstruction.filter;
    }

    const textResponse = rawInstruction.message || rawInstruction.response || rawInstruction.answer || rawInstruction.text;

    if (typeof textResponse === 'string') {
      return unwrapAgentResponse(textResponse);
    }

    return rawInstruction;
  }

  function normalizeFilterInstruction(rawInstruction) {
    const instruction = unwrapAgentResponse(rawInstruction);

    if (!instruction || typeof instruction !== 'object') {
      throw new Error('Agent response did not include a filter instruction.');
    }

    const fieldName = instruction.fieldName || instruction.field || instruction.tableauFieldName;
    const rawValues = instruction.values || instruction.value;
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];

    if (!fieldName || values.length === 0 || values.some((value) => value === undefined || value === null || value === '')) {
      throw new Error('Filter instruction must include fieldName and value(s).');
    }

    return {
      fieldName,
      values: values.map(String),
      applyToAllWorksheets: instruction.applyToAllWorksheets !== false,
      targetWorksheetNames: instruction.targetWorksheetNames || instruction.worksheets || DEFAULT_FILTER.targetWorksheetNames
    };
  }

  function normalizeFilterInstructions(rawInstruction) {
    const instruction = unwrapAgentResponse(rawInstruction);
    const filters = Array.isArray(instruction) ? instruction : [instruction];
    const normalizedFilters = filters
      .filter((filterInstruction) => filterInstruction)
      .map((filterInstruction) => normalizeFilterInstruction(filterInstruction));

    if (normalizedFilters.length === 0) {
      throw new Error('Agent response did not include any Tableau filters.');
    }

    return normalizedFilters;
  }

  async function askAgentForFilter() {
    const prompt = els.agentPrompt.value.trim();

    if (!prompt) {
      throw new Error('Enter a prompt for the agent.');
    }

    setStatus('Asking agent...', 'busy');

    const response = await fetch(AGENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        message: prompt,
        dashboard: {
          name: dashboard.name,
          worksheets: dashboard.worksheets.map((worksheet) => worksheet.name)
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Agent request failed with HTTP ${response.status}.`);
    }

    const responseText = await response.text();
    const agentResult = parseJsonFromText(responseText);
    const filterInstructions = normalizeFilterInstructions(agentResult);
    setAgentAnswer(agentResult.answer);
    setCurrentFilters(filterInstructions);
    setStatus('Agent filter ready', 'ready');
    await applyFilters(filterInstructions);
  }

  async function applyFilter(filterInstruction) {
    const targets = getTargetWorksheets(filterInstruction);

    if (targets.length === 0) {
      throw new Error('No worksheets were found on the dashboard.');
    }

    setStatus('Applying filter...', 'busy');

    const results = await Promise.allSettled(targets.map((worksheet) => {
      return worksheet.applyFilterAsync(
        filterInstruction.fieldName,
        filterInstruction.values,
        tableau.FilterUpdateType.Replace
      );
    }));
    const appliedCount = results.filter((result) => result.status === 'fulfilled').length;

    if (appliedCount === 0) {
      throw new Error(`Could not apply ${filterInstruction.fieldName} to any worksheet.`);
    }

    setStatus('Filter applied', 'ready');
  }

  async function applyFilters(filterInstructions) {
    setStatus('Applying filters...', 'busy');

    for (const filterInstruction of filterInstructions) {
      await applyFilter(filterInstruction);
    }

    setStatus('Dashboard Filter Applied', 'ready');
  }

  async function clearHardCodedFilter() {
    setStatus('Clearing filter...', 'busy');

    for (const filterInstruction of currentFilters) {
      const targets = dashboard.worksheets || [];

      if (targets.length === 0) {
        throw new Error('No worksheets were found on the dashboard.');
      }

      const results = await Promise.allSettled(targets.map((worksheet) => {
        return worksheet.clearFilterAsync(filterInstruction.fieldName);
      }));
      const clearedCount = results.filter((result) => result.status === 'fulfilled').length;

      if (clearedCount === 0) {
        console.warn(`Could not clear ${filterInstruction.fieldName} from any worksheet.`);
      }
    }

    setStatus('Filter cleared', 'ready');
  }

  async function run(action) {
    els.askAgent.disabled = true;
    els.applyLastFilter.disabled = true;
    els.clearFilter.disabled = true;

    try {
      await action();
    } catch (error) {
      setStatus('Tableau filter action failed', 'error');
      console.error(error);
    } finally {
      const isConnected = Boolean(dashboard);
      els.askAgent.disabled = !isConnected;
      els.applyLastFilter.disabled = !isConnected || currentFilters.length === 0;
      els.clearFilter.disabled = !isConnected;
    }
  }

  async function init() {
    setCurrentFilters([DEFAULT_FILTER]);

    if (!window.tableau || !tableau.extensions) {
      setStatus('Open this page from Tableau to initialize the Extensions API', 'error');
      return;
    }

    try {
      await tableau.extensions.initializeAsync();
      dashboard = tableau.extensions.dashboardContent.dashboard;
      els.askAgent.disabled = false;
      els.applyLastFilter.disabled = false;
      els.clearFilter.disabled = false;
      setStatus('Connected to Tableau', 'ready');
    } catch (error) {
      setStatus('Could not initialize Tableau extension', 'error');
      console.error(error);
    }
  }

  els.askAgent.addEventListener('click', () => run(askAgentForFilter));
  els.applyLastFilter.addEventListener('click', () => run(() => applyFilters(currentFilters)));
  els.clearFilter.addEventListener('click', () => run(clearHardCodedFilter));

  init();
}());
