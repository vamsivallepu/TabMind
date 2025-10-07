import OpenAI from 'openai';

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const MAX_TABS_FOR_PROMPT = 40;
const GROUP_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return;
  }

  if (message.type === 'CHECK_API_KEY') {
    getApiKey()
      .then((key) => sendResponse({ apiKeyPresent: Boolean(key) }))
      .catch((error) => {
        console.error('Failed to check API key:', error);
        sendResponse({ apiKeyPresent: false, error: 'Unable to read API key.' });
      });
    return true;
  }

  if (message.type === 'GROUP_TABS') {
    handleGroupTabs(message.regroupAll)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error('Tab grouping failed:', error);
        sendResponse({ success: false, error: error.message || 'Unexpected error.' });
      });
    return true;
  }
});

async function getApiKey() {
  const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
  return typeof geminiApiKey === 'string' && geminiApiKey.trim() ? geminiApiKey.trim() : null;
}

async function handleGroupTabs(regroupAll = true) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { success: false, error: 'Set your Gemini API key in the extension options before grouping.' };
  }

  const allTabs = await chrome.tabs.query({});
  const eligibleTabs = allTabs.filter((tab) => !tab.incognito && !tab.discarded);

  if (!eligibleTabs.length) {
    return { success: false, error: 'No tabs available to group.' };
  }

  // Query existing groups and filter tabs if not regrouping all
  let existingGroups = [];
  let existingGroupsMap = new Map();
  let tabsToProcess = eligibleTabs;

  if (!regroupAll) {
    const allGroups = await chrome.tabGroups.query({});
    
    // Build existing groups information
    for (const group of allGroups) {
      const groupTabs = eligibleTabs.filter((tab) => tab.groupId === group.id);
      if (groupTabs.length > 0) {
        existingGroups.push({
          id: group.id,
          name: group.title || 'Unnamed Group',
          color: group.color,
          tabCount: groupTabs.length,
        });
        existingGroupsMap.set(group.title || 'Unnamed Group', group.id);
      }
    }

    // Only process ungrouped tabs
    tabsToProcess = eligibleTabs.filter((tab) => tab.groupId === -1);

    if (!tabsToProcess.length) {
      return { success: false, error: 'No ungrouped tabs available to process.' };
    }
  }

  const trimmedTabs = tabsToProcess.slice(0, MAX_TABS_FOR_PROMPT);
  const tabPayload = trimmedTabs.map((tab, index) => ({
    id: tab.id,
    title: sanitizeText(tab.title) || '(untitled tab)',
    url: sanitizeUrl(tab.url),
    pinned: Boolean(tab.pinned),
    windowId: tab.windowId,
    position: tab.index,
    sampleOrder: index + 1,
  }));

  const prompt = buildPrompt(tabPayload, tabsToProcess.length, existingGroups);
  const llmResponse = await callOpenAI(apiKey, prompt);
  const groupingPlan = parseGroupingPlan(llmResponse);

  const tabMap = new Map();
  for (const tab of eligibleTabs) {
    tabMap.set(tab.id, tab);
  }

  const summary = await applyGroupingPlan(groupingPlan, tabMap, regroupAll, existingGroupsMap);

  return { success: true, summary };
}

function buildPrompt(tabs, totalCount, existingGroups = []) {
  const hasExistingGroups = existingGroups.length > 0;
  
  let systemPrompt = `You are an expert browser tab organizer. Analyze tab titles and URLs to group them by topic, domain, or purpose.\n\n`;
  
  systemPrompt += `OUTPUT FORMAT (minified JSON only):\n` +
    `type GroupPlan = {\n` +
    `  groups: { name: string; tabIds: number[]; color?: 'grey'|'blue'|'red'|'yellow'|'green'|'pink'|'purple'|'cyan'|'orange' }[];\n` +
    `  ungrouped?: number[];\n` +
    `};\n\n`;

  systemPrompt += `GROUPING STRATEGY:\n`;
  
  if (hasExistingGroups) {
    systemPrompt += `1. PRIORITY: Add tabs to existing groups when semantically related (use EXACT group name).\n` +
      `2. Create new groups only for distinct topics not covered by existing groups.\n` +
      `3. You are organizing UNGROUPED tabs only - do NOT reassign already-grouped tabs.\n`;
  } else {
    systemPrompt += `1. Identify common themes: same domain, related topics, or shared purpose.\n` +
      `2. Group 2-6 related tabs together - avoid single-tab groups as much as possible .\n` +
      `3. Create focused groups with clear themes.\n`;
  }
  
  systemPrompt += `\nGROUP NAMING:\n` +
    `- Use 1 word (e.g., "Shopping", "Research", "GitHub").\n` +
    `- Use 2 words only if needed (e.g., "React Docs", "News Sites").\n` +
    `- Be specific and descriptive (prefer "AWS Console" over "Cloud").\n` +
    `- Match existing group names exactly when adding tabs to them.\n\n`;
  
  systemPrompt += `COLOR SELECTION:\n` +
    `- blue: Documentation, learning, reference\n` +
    `- green: Work, productivity, business\n` +
    `- red: Important, urgent, alerts\n` +
    `- yellow: Social media, entertainment\n` +
    `- purple: Creative, design, media\n` +
    `- orange: Shopping, commerce\n` +
    `- cyan: Development, coding, tools\n` +
    `- pink: Personal, lifestyle\n` +
    `- grey: Miscellaneous, temporary\n` +
    `- Omit color if no clear category fits.\n\n`;
  
  systemPrompt += `STRICT RULES:\n` +
    `- Use ONLY the provided tab IDs.\n` +
    `- Each tab ID appears at most once (in groups OR ungrouped, never both).\n` +
    `- Pinned tabs MUST stay ungrouped.\n` +
    `- Put unrelated/singleton tabs in ungrouped array.\n`;
  
  if (hasExistingGroups) {
    systemPrompt += `- Strongly prefer adding to existing groups over creating new ones.\n` +
      `- Avoid creating too many groups - consolidate where possible.\n`;
  }
  
  systemPrompt += `\nRespond with minified JSON only, no explanation.`;

  const userPayload = {
    totalTabs: totalCount,
    tabs,
  };

  if (totalCount > tabs.length) {
    userPayload.note = `Showing first ${tabs.length} of ${totalCount} tabs.`;
  }

  if (hasExistingGroups) {
    userPayload.existingGroups = existingGroups.map((group) => ({
      name: group.name,
      color: group.color,
      tabCount: group.tabCount,
    }));
  }

  return {
    system: systemPrompt,
    user: JSON.stringify(userPayload),
  };
}

async function callOpenAI(apiKey, prompt) {
  const client = new OpenAI({
    apiKey,
    baseURL: GEMINI_BASE_URL,
    dangerouslyAllowBrowser: true,
  });

  try {
    const response = await client.chat.completions.create({
      model: GEMINI_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Gemini response was empty.');
    }

    return content;
  } catch (error) {
    throw new Error(`Gemini request failed: ${error.message}`);
  }
}

function parseGroupingPlan(rawContent) {
  const jsonString = extractJsonString(rawContent);
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    throw new Error('Model response was not valid JSON.');
  }

  if (!Array.isArray(parsed?.groups)) {
    throw new Error('Model response missing groups array.');
  }

  const groups = parsed.groups.map((group) => ({
    name: sanitizeText(group?.name)?.slice(0, 50) || 'Group',
    tabIds: Array.isArray(group?.tabIds)
      ? group.tabIds.map(Number).filter(Number.isInteger)
      : [],
    color: normalizeColor(group?.color),
  })).filter((group) => group.tabIds.length);

  const ungrouped = Array.isArray(parsed?.ungrouped)
    ? parsed.ungrouped.map(Number).filter(Number.isInteger)
    : [];

  return { groups, ungrouped };
}

function extractJsonString(rawContent) {
  const trimmed = (rawContent ?? '').trim();
  if (!trimmed) {
    throw new Error('No response content to parse.');
  }

  const codeBlockMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Could not locate JSON content in model response.');
}

async function applyGroupingPlan(plan, tabMap, regroupAll = true, existingGroupsMap = new Map()) {
  let groupsApplied = 0;
  let newGroupsCreated = 0;

  if (regroupAll) {
    // Original behavior: ungroup all tabs in the plan and regroup
    const tabIdsInPlan = new Set();
    for (const group of plan.groups) {
      for (const tabId of group.tabIds) {
        tabIdsInPlan.add(tabId);
      }
    }
    for (const tabId of plan.ungrouped) {
      tabIdsInPlan.add(tabId);
    }

    const idsToUngroup = Array.from(tabIdsInPlan).filter((id) => {
      const tab = tabMap.get(id);
      return tab && !tab.pinned;
    });

    if (idsToUngroup.length) {
      try {
        await chrome.tabs.ungroup(idsToUngroup);
      } catch (error) {
        console.warn('Unable to ungroup existing tabs:', error);
      }
    }

    // Create all new groups
    for (const group of plan.groups) {
      const validTabIds = group.tabIds.filter((id) => tabMap.has(id) && !tabMap.get(id).pinned);
      if (!validTabIds.length) {
        continue;
      }

      try {
        const groupId = await chrome.tabs.group({ tabIds: validTabIds });
        const updatePayload = {};
        if (group.name) {
          updatePayload.title = group.name;
        }
        if (group.color) {
          updatePayload.color = group.color;
        }
        if (Object.keys(updatePayload).length) {
          await chrome.tabGroups.update(groupId, updatePayload);
        }
        groupsApplied += 1;
      } catch (error) {
        console.warn('Failed to apply group:', group, error);
      }
    }
  } else {
    // New behavior: add tabs to existing groups or create new groups
    for (const group of plan.groups) {
      const validTabIds = group.tabIds.filter((id) => tabMap.has(id) && !tabMap.get(id).pinned);
      if (!validTabIds.length) {
        continue;
      }

      const existingGroupId = existingGroupsMap.get(group.name);
      
      if (existingGroupId !== undefined) {
        // Add tabs to existing group
        try {
          await chrome.tabs.group({ groupId: existingGroupId, tabIds: validTabIds });
          groupsApplied += 1;
        } catch (error) {
          console.warn('Failed to add tabs to existing group:', group.name, error);
        }
      } else {
        // Create new group
        try {
          const groupId = await chrome.tabs.group({ tabIds: validTabIds });
          const updatePayload = {};
          if (group.name) {
            updatePayload.title = group.name;
          }
          if (group.color) {
            updatePayload.color = group.color;
          }
          if (Object.keys(updatePayload).length) {
            await chrome.tabGroups.update(groupId, updatePayload);
          }
          groupsApplied += 1;
          newGroupsCreated += 1;
        } catch (error) {
          console.warn('Failed to create new group:', group, error);
        }
      }
    }
  }

  const ungroupedIds = plan.ungrouped.filter((id) => tabMap.has(id));
  if (ungroupedIds.length && regroupAll) {
    try {
      await chrome.tabs.ungroup(ungroupedIds);
    } catch (error) {
      console.warn('Failed to leave tabs ungrouped:', error);
    }
  }

  return { groups: groupsApplied, ungrouped: ungroupedIds.length };
}

function normalizeColor(rawColor) {
  if (typeof rawColor !== 'string') {
    return undefined;
  }
  const lower = rawColor.toLowerCase();
  return GROUP_COLORS.has(lower) ? lower : undefined;
}

function sanitizeText(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(/[\n\r\t]+/g, ' ').trim();
}

function sanitizeUrl(url) {
  if (typeof url !== 'string') {
    return '';
  }
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch (error) {
    return url;
  }
}
