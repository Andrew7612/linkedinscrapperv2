// popup.js — control plane for the LinkedIn Connection Scraper extension

// ─── State ────────────────────────────────────────────────────────────────────
let state = "IDLE"; // IDLE | SCRAPING | COMPLETE | ERROR

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const sControls  = document.getElementById("section-controls");
const sProgress  = document.getElementById("section-progress");
const sResults   = document.getElementById("section-results");

const schoolInput     = document.getElementById("school-input");
const enrolledToggle  = document.getElementById("enrolled-toggle");
const startBtn        = document.getElementById("start-btn");
const stopBtn         = document.getElementById("stop-btn");
const tabError        = document.getElementById("tab-error");

const progressLabel   = document.getElementById("progress-label");
const progressCount   = document.getElementById("progress-count");
const progressBar     = document.getElementById("progress-bar");
const progressStatus  = document.getElementById("progress-status");

const resultsCount    = document.getElementById("results-count");
const resultsLabel    = document.getElementById("results-label");
const resultsBody     = document.getElementById("results-body");
const resultsTableWrap = document.getElementById("results-table-wrap");
const noResults       = document.getElementById("no-results");
const exportBtn       = document.getElementById("export-btn");
const skippedNote     = document.getElementById("skipped-note");
const resetBtn        = document.getElementById("reset-btn");
const resetBtn2       = document.getElementById("reset-btn-2");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function show(el)  { el.classList.remove("hidden"); }
function hide(el)  { el.classList.add("hidden"); }

function showSection(name) {
  hide(sControls);
  hide(sProgress);
  hide(sResults);
  if (name === "controls")  show(sControls);
  if (name === "progress")  show(sProgress);
  if (name === "results")   show(sResults);
}

// ─── CSRF extraction ──────────────────────────────────────────────────────────
async function getCsrfToken() {
  const cookie = await chrome.cookies.get({
    url: "https://www.linkedin.com",
    name: "JSESSIONID",
  });
  if (!cookie) return null;
  // LinkedIn stores it as: "ajax:1234567890123456789" (with surrounding quotes)
  return cookie.value.replace(/^"|"$/g, "");
}

// ─── Tab validation ───────────────────────────────────────────────────────────
async function getLinkedInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("linkedin.com")) return null;
  return tab;
}

// ─── Content script injection ─────────────────────────────────────────────────
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"],
    });
    return true;
  } catch (err) {
    console.error("Injection failed:", err);
    return false;
  }
}

// ─── Start scraping ───────────────────────────────────────────────────────────
startBtn.addEventListener("click", async () => {
  const schoolName = schoolInput.value.trim();
  if (!schoolName) {
    schoolInput.focus();
    schoolInput.style.borderColor = "#c0392b";
    return;
  }
  schoolInput.style.borderColor = "";

  hide(tabError);

  const tab = await getLinkedInTab();
  if (!tab) {
    show(tabError);
    return;
  }

  const csrfToken = await getCsrfToken();
  if (!csrfToken) {
    tabError.textContent = "Could not read LinkedIn session. Make sure you are logged in to LinkedIn.";
    show(tabError);
    return;
  }

  // Switch to progress view
  state = "SCRAPING";
  showSection("progress");
  progressBar.value = 0;
  progressBar.max = 100;
  progressCount.textContent = "0 / ?";
  progressLabel.textContent = "Fetching connections…";
  progressStatus.textContent = "";

  const injected = await injectContentScript(tab.id);
  if (!injected) {
    showError("Failed to inject scraper into LinkedIn tab. Try refreshing LinkedIn and try again.");
    return;
  }

  // Small delay to let content script initialize
  await new Promise(r => setTimeout(r, 150));

  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: "start",
      schoolName,
      currentlyEnrolledOnly: enrolledToggle.checked,
      csrfToken,
    });
  } catch (err) {
    showError("Could not communicate with LinkedIn tab. Please refresh LinkedIn and try again.");
  }
});

// ─── Stop scraping ────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", async () => {
  const tab = await getLinkedInTab();
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, { action: "stop" }); } catch (_) {}
  }
  showSection("controls");
  state = "IDLE";
});

// ─── Reset buttons ────────────────────────────────────────────────────────────
[resetBtn, resetBtn2].forEach(btn => {
  if (btn) btn.addEventListener("click", () => {
    showSection("controls");
    state = "IDLE";
  });
});

// ─── Message listener (from content.js) ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "progress") {
    const { fetched, total } = message;
    progressCount.textContent = `${fetched} / ${total ?? "?"}`;
    if (total) {
      progressBar.max = total;
      progressBar.value = fetched;
    }
    progressLabel.textContent = "Fetching connections…";
  }

  if (message.action === "status") {
    progressStatus.textContent = message.text ?? "";
  }

  if (message.action === "complete") {
    state = "COMPLETE";
    renderResults(message.results, message.skipped ?? 0);
  }

  if (message.action === "error") {
    showError(message.message);
  }
});

// ─── Error display ────────────────────────────────────────────────────────────
function showError(msg) {
  state = "ERROR";
  showSection("controls");
  tabError.innerHTML = msg;
  show(tabError);
}

// ─── Results rendering ────────────────────────────────────────────────────────
function renderResults(results, skipped) {
  showSection("results");
  resultsBody.innerHTML = "";

  resultsCount.textContent = results.length;
  resultsLabel.textContent = results.length === 1 ? " matching connection" : " matching connections";

  if (skipped > 0) {
    skippedNote.textContent = `${skipped} connection${skipped === 1 ? "" : "s"} skipped (no education data)`;
    show(skippedNote);
  } else {
    hide(skippedNote);
  }

  if (results.length === 0) {
    show(noResults);
    hide(resultsTableWrap);
    hide(exportBtn);
    return;
  }

  hide(noResults);
  show(resultsTableWrap);
  show(exportBtn);

  results.forEach(conn => {
    const edu = conn.matchedEducation;
    const enrolled = edu.currentlyEnrolled;
    const degreeField = [edu.degreeName, edu.fieldOfStudy].filter(Boolean).join(" / ") || "—";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="name-cell" title="${esc(conn.firstName + " " + conn.lastName)}">
        ${esc(conn.firstName)} ${esc(conn.lastName)}
      </td>
      <td class="school-cell" title="${esc(edu.schoolName)}">${esc(edu.schoolName)}</td>
      <td class="degree-cell" title="${esc(degreeField)}">${esc(degreeField)}</td>
      <td>
        <span class="enrolled-badge ${enrolled ? "enrolled-yes" : "enrolled-no"}">
          ${enrolled ? "Current" : "Alumni"}
        </span>
      </td>
      <td>
        <a class="profile-link" href="${esc(conn.profileUrl)}" target="_blank" rel="noopener">View</a>
      </td>
    `;
    resultsBody.appendChild(tr);
  });

  // Store results for CSV export
  exportBtn._results = results;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── CSV export ───────────────────────────────────────────────────────────────
exportBtn.addEventListener("click", () => {
  const results = exportBtn._results;
  if (!results || results.length === 0) return;

  const schoolName = schoolInput.value.trim().replace(/\s+/g, "_") || "school";
  const csv = generateCSV(results);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `linkedin_${schoolName}_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

function generateCSV(results) {
  const headers = [
    "First Name",
    "Last Name",
    "Profile URL",
    "Headline",
    "School Name",
    "Degree",
    "Field of Study",
    "Start Year",
    "End Year",
    "Currently Enrolled",
  ];

  const csvEsc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

  const rows = results.map(c => {
    const edu = c.matchedEducation;
    return [
      csvEsc(c.firstName),
      csvEsc(c.lastName),
      csvEsc(c.profileUrl),
      csvEsc(c.headline),
      csvEsc(edu.schoolName),
      csvEsc(edu.degreeName),
      csvEsc(edu.fieldOfStudy),
      csvEsc(edu.startYear),
      csvEsc(edu.endYear),
      csvEsc(edu.currentlyEnrolled ? "Yes" : "No"),
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\r\n");
}

// ─── Init — check for cached results from a previous scrape ──────────────────
(async () => {
  const cached = await chrome.storage.session.get("scrapedResults").catch(() => ({}));
  if (cached.scrapedResults) {
    renderResults(cached.scrapedResults.results, cached.scrapedResults.skipped ?? 0);
    if (cached.scrapedResults.schoolName) {
      schoolInput.value = cached.scrapedResults.schoolName;
    }
  }
})();
