const statusEl = document.getElementById('status');
const groupBtn = document.getElementById('groupTabs');
const toggleApiKeyBtn = document.getElementById('toggleApiKey');
const apiKeySection = document.getElementById('apiKeySection');
const apiKeyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
const regroupAllCheckbox = document.getElementById('regroupAll');

function setStatus(message, type = '') {
  statusEl.textContent = message ?? '';
  statusEl.className = `status ${type}`.trim();
}

function toggleApiKeySection() {
  const isHidden = apiKeySection.classList.contains('hidden');
  if (isHidden) {
    apiKeySection.classList.remove('hidden');
    toggleApiKeyBtn.textContent = 'Hide API Key';
    loadApiKey();
  } else {
    apiKeySection.classList.add('hidden');
    toggleApiKeyBtn.textContent = 'Set API Key';
  }
}

async function loadApiKey() {
  try {
    const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
    if (geminiApiKey) {
      apiKeyInput.value = geminiApiKey;
    }
  } catch (error) {
    console.error('Failed to load API key:', error);
  }
}

async function saveApiKey() {
  const rawKey = apiKeyInput.value.trim();
  if (!rawKey) {
    setStatus('Enter a valid API key before saving.', 'error');
    return;
  }

  try {
    await chrome.storage.local.set({ geminiApiKey: rawKey });
    setStatus('API key saved successfully.', 'success');
    setTimeout(() => {
      checkKeyStatus();
      toggleApiKeySection();
    }, 1000);
  } catch (error) {
    console.error('Failed to save API key:', error);
    setStatus('Error saving API key.', 'error');
  }
}

async function clearApiKey() {
  try {
    await chrome.storage.local.remove(['geminiApiKey']);
    apiKeyInput.value = '';
    setStatus('API key cleared.', 'success');
    setTimeout(() => {
      checkKeyStatus();
    }, 500);
  } catch (error) {
    console.error('Failed to clear API key:', error);
    setStatus('Error clearing API key.', 'error');
  }
}

async function loadCheckboxState() {
  try {
    const { regroupAll } = await chrome.storage.local.get(['regroupAll']);
    regroupAllCheckbox.checked = regroupAll === true;
  } catch (error) {
    console.error('Failed to load checkbox state:', error);
  }
}

async function saveCheckboxState() {
  try {
    await chrome.storage.local.set({ regroupAll: regroupAllCheckbox.checked });
  } catch (error) {
    console.error('Failed to save checkbox state:', error);
  }
}

async function checkKeyStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CHECK_API_KEY' });
    if (response?.apiKeyPresent) {
      setStatus('Ready to group tabs.', 'success');
      groupBtn.disabled = false;
      toggleApiKeyBtn.textContent = 'Update API Key';
    } else {
      setStatus('Add your Gemini API key to get started.', 'error');
      groupBtn.disabled = true;
      toggleApiKeyBtn.textContent = 'Set API Key';
    }
  } catch (error) {
    console.error(error);
    setStatus('Unable to reach background script.', 'error');
    groupBtn.disabled = true;
  }
}

async function handleGroupTabs() {
  setStatus('Grouping tabs…');
  groupBtn.disabled = true;

  // Save checkbox state
  await saveCheckboxState();

  try {
    const response = await chrome.runtime.sendMessage({ 
      type: 'GROUP_TABS',
      regroupAll: regroupAllCheckbox.checked
    });
    if (response?.success) {
      const groupsCreated = response.summary?.groups ?? 0;
      const ungrouped = response.summary?.ungrouped ?? 0;
      setStatus(`Grouped tabs into ${groupsCreated} group(s). ${ungrouped} left ungrouped.`, 'success');
    } else {
      const message = response?.error || 'Failed to group tabs.';
      setStatus(message, 'error');
    }
  } catch (error) {
    console.error(error);
    setStatus('Unexpected error. Check the service worker logs.', 'error');
  } finally {
    setTimeout(() => checkKeyStatus(), 250);
  }
}

groupBtn.addEventListener('click', handleGroupTabs);
toggleApiKeyBtn.addEventListener('click', toggleApiKeySection);
saveBtn.addEventListener('click', saveApiKey);
clearBtn.addEventListener('click', clearApiKey);
regroupAllCheckbox.addEventListener('change', saveCheckboxState);

document.addEventListener('DOMContentLoaded', () => {
  checkKeyStatus();
  loadCheckboxState();
});
