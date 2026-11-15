/**
 * Builds two GitHub analytics SVGs from the GitHub GraphQL API:
 * assets/analytics/stats.svg and assets/analytics/languages.svg.
 *
 * Measurements, matched to the public schema:
 * - contributionsCollection.contributionCalendar.totalContributions
 * - totalCommitContributions: commits authored in the window
 * - totalPullRequestContributions: pull requests opened (default arguments)
 * - totalIssueContributions: issues opened (default arguments)
 * - restrictedContributionsCount: private contributions the viewer cannot open
 * - Repository.stargazerCount and languages.edges.size (bytes) for public
 *   non-fork repositories owned by the profile (ownerAffiliations: OWNER)
 *
 * ContributionCalendarDay.weekday uses Monday = 1, so Sunday = 0.
 * The requested window is kept strictly under 365 days.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROFILE_LOGIN = "roshelpeter-cpu";
const API_URL = "https://api.github.com/graphql";
const MAX_REPO_PAGES = 20;
const MAX_LANGUAGE_SLICES = 6;

const LEVEL_COLORS = {
  NONE: "#2A1520",
  FIRST_QUARTILE: "#5A2036",
  SECOND_QUARTILE: "#8F1D3F",
  THIRD_QUARTILE: "#C43256",
  FOURTH_QUARTILE: "#EF355D",
};

const SLICE_COLORS = ["#EF355D", "#F28BA3", "#C43256", "#8F1D3F", "#E7B3C0", "#6E3148"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SANS = "'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "Consolas, 'Segoe UI Mono', monospace";

const VIEWER_QUERY = `query { viewer { login } }`;

const CONTRIBUTIONS_QUERY = `
query AnalyticsContributions($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    login
    contributionsCollection(from: $from, to: $to) {
      restrictedContributionsCount
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      contributionCalendar {
        totalContributions
        weeks {
          firstDay
          contributionDays {
            contributionCount
            contributionLevel
            date
            weekday
          }
        }
      }
    }
  }
}`;

const REPOSITORIES_QUERY = `
query AnalyticsRepos($login: String!, $after: String) {
  user(login: $login) {
    login
    repositories(
      first: 40
      after: $after
      privacy: PUBLIC
      isFork: false
      ownerAffiliations: [OWNER]
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        stargazerCount
        languages(first: 50, orderBy: { field: SIZE, direction: DESC }) {
          pageInfo { hasNextPage }
          edges { size node { name } }
        }
      }
    }
  }
}`;

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function analyticsDirectory() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "analytics");
}

export function defaultAnalyticsOutputs() {
  const directory = analyticsDirectory();
  return {
    stats: path.join(directory, "stats.svg"),
    languages: path.join(directory, "languages.svg"),
  };
}

export function defaultAnalyticsPath() {
  return defaultAnalyticsOutputs().stats;
}

export function contributionWindow(now = new Date()) {
  const to = new Date(now.getTime());
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  from.setUTCDate(from.getUTCDate() + 1);
  const maxSpan = 365 * 24 * 60 * 60 * 1000;
  while (to.getTime() - from.getTime() >= maxSpan) from.setUTCDate(from.getUTCDate() + 1);
  return {
    from: from.toISOString().replace(".000Z", "Z"),
    to: to.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

export function previousIsoDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function isNextDay(previous, next) {
  return previousIsoDate(next) === previous;
}

function assertIsoDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Unexpected ${label}. The existing analytics image was left unchanged.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Unexpected ${label}. The existing analytics image was left unchanged.`);
  }
  return value;
}

function assertCount(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unexpected ${label}. The existing analytics image was left unchanged.`);
  }
  return value;
}

function assertLabel(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80 || /[\u0000-\u001F]/.test(value)) {
    throw new Error(`Unexpected ${label}. The existing analytics image was left unchanged.`);
  }
  return value;
}

export function calculateStreaks(days) {
  if (!Array.isArray(days) || days.length === 0) {
    return { current: 0, longest: 0, currentIsCensored: false };
  }
  const sorted = days.map((day) => ({
    date: assertIsoDate(day.date, "contribution date"),
    count: assertCount(day.count, "contribution count"),
  })).sort((a, b) => a.date.localeCompare(b.date));

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].date === sorted[index - 1].date) {
      throw new Error(`Duplicate contribution date ${sorted[index].date}. The existing analytics image was left unchanged.`);
    }
  }

  let longest = 0;
  let run = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const continues = index > 0
      && sorted[index - 1].count > 0
      && isNextDay(sorted[index - 1].date, sorted[index].date);
    if (sorted[index].count > 0 && continues) run += 1;
    else if (sorted[index].count > 0) run = 1;
    else run = 0;
    if (run > longest) longest = run;
  }

  const last = sorted[sorted.length - 1];
  let startIndex = sorted.length - 1;
  if (last.count === 0) {
    const yesterday = previousIsoDate(last.date);
    startIndex = sorted.findIndex((day) => day.date === yesterday);
    if (startIndex === -1 || sorted[startIndex].count === 0) {
      return { current: 0, longest, currentIsCensored: false };
    }
  }

  let current = 0;
  let expected = sorted[startIndex].date;
  let currentIsCensored = false;
  for (let index = startIndex; index >= 0; index -= 1) {
    if (sorted[index].date !== expected || sorted[index].count <= 0) break;
    current += 1;
    if (index === 0) currentIsCensored = true;
    expected = previousIsoDate(expected);
  }

  return { current, longest, currentIsCensored };
}

export function monthsInRange(fromIso, toIso) {
  const from = assertIsoDate(fromIso, "window start");
  const to = assertIsoDate(toIso, "window end");
  if (from > to) throw new Error("The contribution window is reversed. The existing analytics image was left unchanged.");
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  const keys = [];
  while (keys.length < 16) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    keys.push(key);
    if (key === endKey) return keys;
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  throw new Error("The contribution window is too long. The existing analytics image was left unchanged.");
}

export function monthlyTotals(days, fromIso, toIso) {
  const keys = monthsInRange(fromIso, toIso);
  const totals = new Map(keys.map((key) => [key, 0]));
  for (const day of days) {
    const date = assertIsoDate(day.date, "contribution date");
    const count = assertCount(day.count, "contribution count");
    if (date < fromIso || date > toIso) continue;
    const key = date.slice(0, 7);
    if (totals.has(key)) totals.set(key, totals.get(key) + count);
  }
  return keys.map((key) => ({
    key,
    label: MONTHS[Number(key.slice(5, 7)) - 1],
    year: key.slice(0, 4),
    total: totals.get(key),
  }));
}

export function languageDistribution(repos, maxSlices = MAX_LANGUAGE_SLICES) {
  const totals = new Map();
  for (const repo of repos) {
    for (const language of repo.languages) {
      const name = assertLabel(language.name, "language name");
      const size = assertCount(language.size, "language size");
      if (size === 0) continue;
      totals.set(name, (totals.get(name) ?? 0) + size);
    }
  }
  const entries = [...totals.entries()]
    .map(([name, size]) => ({ name, size }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes === 0) return { totalBytes: 0, slices: [] };

  let slices;
  if (entries.length <= maxSlices) slices = entries;
  else {
    const head = entries.slice(0, maxSlices - 1);
    const otherSize = entries.slice(maxSlices - 1).reduce((sum, entry) => sum + entry.size, 0);
    slices = [...head, { name: "Other", size: otherSize }];
  }

  const tenths = slices.map((slice) => {
    const exact = (slice.size / totalBytes) * 1000;
    return { ...slice, tenths: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = 1000 - tenths.reduce((sum, slice) => sum + slice.tenths, 0);
  const order = tenths
    .map((slice, index) => ({ index, remainder: slice.remainder }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) tenths[order[index].index].tenths += 1;

  return {
    totalBytes,
    slices: tenths.map((slice, index) => ({
      name: slice.name,
      size: slice.size,
      tenths: slice.tenths,
      percentLabel: `${(slice.tenths / 10).toFixed(1)}%`,
      color: SLICE_COLORS[index % SLICE_COLORS.length],
    })),
  };
}

export function heatmapLayout(weeks, { originX = 0, originY = 0, cell = 11, gap = 3 } = {}) {
  const pitch = cell + gap;
  const cells = [];
  weeks.forEach((week, weekIndex) => {
    for (const day of week.contributionDays) {
      if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6) {
        throw new Error(`Unexpected weekday for ${day.date}. The existing analytics image was left unchanged.`);
      }
      cells.push({
        ...day,
        weekIndex,
        x: originX + weekIndex * pitch,
        y: originY + day.weekday * pitch,
      });
    }
  });

  const candidates = [];
  weeks.forEach((week, weekIndex) => {
    const monthStart = week.contributionDays.find((day) => day.date.endsWith("-01"));
    const source = monthStart ?? (weekIndex === 0 ? week.contributionDays[0] : null);
    if (!source) return;
    if (candidates.some((item) => item.weekIndex === weekIndex)) return;
    candidates.push({ weekIndex, text: MONTHS[Number(source.date.slice(5, 7)) - 1] });
  });
  const monthLabels = [];
  let lastWeek = -10;
  for (const candidate of candidates) {
    if (candidate.weekIndex !== 0 && candidate.weekIndex - lastWeek < 2) continue;
    monthLabels.push({
      ...candidate,
      x: originX + candidate.weekIndex * pitch,
    });
    lastWeek = candidate.weekIndex;
  }
  return { cells, monthLabels, pitch, width: Math.max(0, weeks.length * pitch - gap) };
}

function flattenDays(weeks) {
  return weeks.flatMap((week) => week.contributionDays.map((day) => ({
    date: day.date,
    count: day.count,
  })));
}

export function normalizeApiPayload({ login, from, to, totalCount, nodes, collection }) {
  const safeLogin = assertLabel(login, "login");
  if (!/^[A-Za-z0-9-]+$/.test(safeLogin)) {
    throw new Error("Unexpected login. The existing analytics image was left unchanged.");
  }
  const windowStart = assertIsoDate(from.slice(0, 10), "window start");
  const windowEnd = assertIsoDate(to.slice(0, 10), "window end");
  const expectedCount = assertCount(totalCount, "repository count");
  if (!Array.isArray(nodes)) {
    throw new Error("Repository data was incomplete. The existing analytics image was left unchanged.");
  }
  if (nodes.length !== expectedCount) {
    throw new Error("Repository data was incomplete. The existing analytics image was left unchanged.");
  }

  const repos = nodes.map((node) => {
    if (!node || typeof node.name !== "string") {
      throw new Error("Repository data was incomplete. The existing analytics image was left unchanged.");
    }
    const languages = node.languages;
    if (languages == null) return { name: node.name, stargazerCount: assertCount(node.stargazerCount, "star count"), languages: [] };
    if (languages.pageInfo?.hasNextPage) {
      throw new Error(`Language data for ${node.name} was incomplete. The existing analytics image was left unchanged.`);
    }
    const edges = languages.edges ?? [];
    return {
      name: assertLabel(node.name, "repository name"),
      stargazerCount: assertCount(node.stargazerCount, "star count"),
      languages: edges.map((edge) => {
        if (!edge?.node?.name) {
          throw new Error("Language data was incomplete. The existing analytics image was left unchanged.");
        }
        return { name: edge.node.name, size: edge.size };
      }),
    };
  });

  const calendar = collection?.contributionCalendar;
  if (!calendar || !Array.isArray(calendar.weeks)) {
    throw new Error("Contribution data was incomplete. The existing analytics image was left unchanged.");
  }
  const weeks = calendar.weeks.map((week) => {
    if (!week || !Array.isArray(week.contributionDays)) {
      throw new Error("Contribution data was incomplete. The existing analytics image was left unchanged.");
    }
    return {
      firstDay: assertIsoDate(week.firstDay, "week start"),
      contributionDays: week.contributionDays.map((day) => ({
        date: assertIsoDate(day.date, "contribution date"),
        weekday: day.weekday,
        count: assertCount(day.contributionCount, "contribution count"),
        level: day.contributionLevel,
      })),
    };
  });
  for (const week of weeks) {
    for (const day of week.contributionDays) {
      if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6) {
        throw new Error(`Unexpected weekday for ${day.date}. The existing analytics image was left unchanged.`);
      }
      if (day.level != null && !Object.hasOwn(LEVEL_COLORS, day.level)) {
        throw new Error(`Unexpected contribution level for ${day.date}. The existing analytics image was left unchanged.`);
      }
    }
  }

  const days = flattenDays(weeks);
  return {
    login: safeLogin,
    from: windowStart,
    to: windowEnd,
    repositories: repos.length,
    stars: repos.reduce((sum, repo) => sum + repo.stargazerCount, 0),
    contributions: assertCount(calendar.totalContributions, "contribution total"),
    commits: assertCount(collection.totalCommitContributions, "commit total"),
    pullRequests: assertCount(collection.totalPullRequestContributions, "pull request total"),
    issues: assertCount(collection.totalIssueContributions, "issue total"),
    restrictedContributions: assertCount(collection.restrictedContributionsCount, "private contribution count"),
    weeks,
    streaks: calculateStreaks(days),
    months: monthlyTotals(days, windowStart, windowEnd),
    languages: languageDistribution(repos),
  };
}

export function formatCount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function icon(name, x, y) {
  const paths = {
    repositories: `<rect x="3" y="7" width="18" height="13" rx="2" fill="none" stroke="#EF355D" stroke-width="1.6"/><path d="M3 11h18M8 7V5h8v2" fill="none" stroke="#EF355D" stroke-width="1.6" stroke-linejoin="round"/>`,
    contributions: `<g fill="#EF355D"><rect x="3" y="4" width="5" height="5" rx="1" opacity="0.45"/><rect x="10" y="4" width="5" height="5" rx="1"/><rect x="17" y="4" width="4" height="5" rx="1" opacity="0.7"/><rect x="3" y="11" width="5" height="5" rx="1" opacity="0.8"/><rect x="10" y="11" width="5" height="5" rx="1" opacity="0.35"/><rect x="17" y="11" width="4" height="5" rx="1"/><rect x="3" y="18" width="5" height="4" rx="1" opacity="0.55"/><rect x="10" y="18" width="5" height="4" rx="1"/><rect x="17" y="18" width="4" height="4" rx="1" opacity="0.4"/></g>`,
    commits: `<circle cx="6" cy="12" r="2.2" fill="none" stroke="#EF355D" stroke-width="1.6"/><circle cx="18" cy="6" r="2.2" fill="none" stroke="#EF355D" stroke-width="1.6"/><circle cx="18" cy="18" r="2.2" fill="none" stroke="#EF355D" stroke-width="1.6"/><path d="M8.2 12H14M14 12c0-3.2 1.6-6 4-6M14 12c0 3.2 1.6 6 4 6" fill="none" stroke="#EF355D" stroke-width="1.6"/>`,
    pulls: `<circle cx="6" cy="6" r="2.2" fill="none" stroke="#EF355D" stroke-width="1.6"/><circle cx="6" cy="18" r="2.2" fill="none" stroke="#EF355D" stroke-width="1.6"/><circle cx="18" cy="12" r="2.2" fill="none" stroke="#EF355D" stroke-width="1.6"/><path d="M6 8.2v7.6M8.2 12H16" fill="none" stroke="#EF355D" stroke-width="1.6"/>`,
    issues: `<circle cx="12" cy="12" r="8" fill="none" stroke="#EF355D" stroke-width="1.6"/><circle cx="12" cy="12" r="1.7" fill="#EF355D"/>`,
    stars: `<path d="M12 3.4 14.3 8.7 20 9.3 15.7 13.2 16.9 18.8 12 16.1 7.1 18.8 8.3 13.2 4 9.3 9.7 8.7Z" fill="none" stroke="#EF355D" stroke-width="1.4" stroke-linejoin="round"/>`,
  };
  return `<g transform="translate(${x} ${y})">${paths[name]}</g>`;
}

function metricCard(x, y, spec) {
  return `<g>
    <rect x="${x}" y="${y}" width="182" height="112" rx="16" fill="#1B1018" stroke="#43202F"/>
    ${icon(spec.icon, x + 14, y + 14)}
    <text x="${x + 46}" y="${y + 28}" fill="#F5F0F2" font-size="13" font-family="${SANS}">${escapeXml(spec.label)}</text>
    <text x="${x + 46}" y="${y + 46}" fill="#B7AAB1" font-size="11" font-family="${SANS}">${escapeXml(spec.subtitle)}</text>
    <text data-metric="${escapeXml(spec.metric)}" x="${x + 16}" y="${y + 90}" fill="#F5F0F2" font-size="30" font-weight="700" font-family="${SANS}">${escapeXml(spec.value)}</text>
  </g>`;
}

function dayColor(day) {
  if (day.count <= 0) return LEVEL_COLORS.NONE;
  if (day.level && day.level !== "NONE" && LEVEL_COLORS[day.level]) return LEVEL_COLORS[day.level];
  return LEVEL_COLORS.FIRST_QUARTILE;
}

function renderHeatmap(model) {
  const originX = 86;
  const originY = 286;
  const available = 640;
  const weeks = Math.max(model.weeks.length, 1);
  const pitch = Math.min(13, available / weeks);
  const cell = Math.max(7, pitch - 2.5);
  const layout = heatmapLayout(model.weeks, { originX, originY, cell, gap: pitch - cell });
  const squares = layout.cells.map((day) => {
    const label = `${day.date}: ${day.count} ${day.count === 1 ? "contribution" : "contributions"}`;
    return `<rect x="${day.x.toFixed(2)}" y="${day.y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="2" fill="${dayColor(day)}"><title>${escapeXml(label)}</title></rect>`;
  }).join("");
  const monthText = layout.monthLabels.map((month) => (
    `<text x="${month.x.toFixed(2)}" y="${originY - 10}" fill="#B7AAB1" font-size="11" font-family="${SANS}">${escapeXml(month.text)}</text>`
  )).join("");
  const dayLabels = [["Mon", 1], ["Wed", 3], ["Fri", 5]].map(([text, row]) => (
    `<text x="${originX - 10}" y="${(originY + row * layout.pitch + cell - 1).toFixed(2)}" text-anchor="end" fill="#B7AAB1" font-size="11" font-family="${SANS}">${text}</text>`
  )).join("");
  const legendX = 500;
  const legendY = 414;
  const swatches = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"].map((level, index) => (
    `<rect x="${legendX + 36 + index * 16}" y="${legendY}" width="12" height="12" rx="2" fill="${LEVEL_COLORS[level]}"/>`
  )).join("");
  const empty = model.weeks.length === 0
    ? `<text x="86" y="360" fill="#B7AAB1" font-size="14" font-family="${SANS}">No contribution days were returned for this window.</text>`
    : "";
  return `<g>
    <rect x="24" y="216" width="748" height="230" rx="18" fill="#1B1018" stroke="#43202F"/>
    <text x="44" y="248" fill="#F5F0F2" font-size="18" font-weight="650" font-family="${SANS}">Contribution activity</text>
    <text x="430" y="248" fill="#B7AAB1" font-size="12" font-family="${SANS}">${escapeXml(model.from)} to ${escapeXml(model.to)}</text>
    ${monthText}
    ${dayLabels}
    ${squares}
    ${empty}
    <text x="${legendX}" y="${legendY + 10}" fill="#B7AAB1" font-size="11" font-family="${SANS}">Less</text>
    ${swatches}
    <text x="${legendX + 122}" y="${legendY + 10}" fill="#B7AAB1" font-size="11" font-family="${SANS}">More</text>
  </g>`;
}

function renderStreak(model) {
  const cx = 900;
  const cy = 330;
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const { current, longest, currentIsCensored } = model.streaks;
  const ratio = longest === 0 ? 0 : current / longest;
  const currentLabel = `${current}${currentIsCensored ? "+" : ""}`;
  const ring = ratio >= 0.999
    ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#EF355D" stroke-width="12"/>`
    : ratio > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#EF355D" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(ratio * circumference).toFixed(2)} ${(circumference - ratio * circumference).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
      : "";
  const note = currentIsCensored
    ? `<text x="808" y="424" fill="#B7AAB1" font-size="11" font-family="${SANS}">Reaches the first day returned for this window.</text>`
    : "";
  return `<g>
    <rect x="788" y="216" width="388" height="230" rx="18" fill="#1B1018" stroke="#43202F"/>
    <text x="808" y="248" fill="#F5F0F2" font-size="18" font-weight="650" font-family="${SANS}">Contribution streak</text>
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#2A1520" stroke-width="12"/>
    ${ring}
    <text data-streak="current" x="${cx}" y="${cy + 8}" text-anchor="middle" fill="#F5F0F2" font-size="28" font-weight="700" font-family="${SANS}">${escapeXml(currentLabel)}</text>
    <text x="990" y="300" fill="#B7AAB1" font-size="12" font-family="${SANS}">Current streak</text>
    <text x="990" y="324" fill="#F5F0F2" font-size="18" font-weight="650" font-family="${SANS}">${escapeXml(currentLabel)} ${current === 1 ? "day" : "days"}</text>
    <text x="990" y="362" fill="#B7AAB1" font-size="12" font-family="${SANS}">Longest in this window</text>
    <text data-streak="longest" x="990" y="386" fill="#F5F0F2" font-size="18" font-weight="650" font-family="${SANS}">${longest} ${longest === 1 ? "day" : "days"}</text>
    ${note}
  </g>`;
}

function renderActivity(model) {
  const plotX = 88;
  const plotY = 548;
  const plotW = 450;
  const plotH = 120;
  const totals = model.months.map((month) => month.total);
  const axisMax = totals.length ? Math.max(...totals) : 0;
  const scaleMax = Math.max(axisMax, 1);
  const points = model.months.map((month, index) => {
    const x = plotX + (model.months.length === 1 ? plotW / 2 : (index / (model.months.length - 1)) * plotW);
    const y = plotY + plotH - (month.total / scaleMax) * plotH;
    return { ...month, x, y };
  });
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const area = points.length
    ? `${line} L${points[points.length - 1].x.toFixed(2)} ${(plotY + plotH).toFixed(2)} L${points[0].x.toFixed(2)} ${(plotY + plotH).toFixed(2)} Z`
    : "";
  const labels = points.map((point, index) => {
    const showYear = index === 0 || point.label === "Jan";
    return `<text x="${point.x.toFixed(2)}" y="${plotY + plotH + 22}" text-anchor="middle" fill="#B7AAB1" font-size="11" font-family="${SANS}">${escapeXml(point.label)}</text>
      ${showYear ? `<text x="${point.x.toFixed(2)}" y="${plotY + plotH + 36}" text-anchor="middle" fill="#8C7B84" font-size="10" font-family="${SANS}">${escapeXml(point.year)}</text>` : ""}`;
  }).join("");
  const grid = [0, 0.5, 1].map((step) => {
    const y = plotY + plotH - step * plotH;
    const value = Math.round(axisMax * step);
    return `<line x1="${plotX}" y1="${y.toFixed(2)}" x2="${plotX + plotW}" y2="${y.toFixed(2)}" stroke="#43202F"/>
      <text x="${plotX - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#8C7B84" font-size="10" font-family="${SANS}">${value}</text>`;
  }).join("");
  return `<g>
    <rect x="24" y="462" width="568" height="270" rx="18" fill="#1B1018" stroke="#43202F"/>
    <text x="44" y="492" fill="#F5F0F2" font-size="18" font-weight="650" font-family="${SANS}">Activity overview</text>
    <text x="44" y="512" fill="#B7AAB1" font-size="12" font-family="${SANS}">Contributions per calendar month in this window</text>
    ${grid}
    <path d="${area}" fill="url(#areaFill)"/>
    <path d="${line}" fill="none" stroke="#EF355D" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3" fill="#F5F0F2" stroke="#EF355D" stroke-width="1.5"><title>${escapeXml(`${point.label} ${point.year}: ${point.total}`)}</title></circle>`).join("")}
    ${labels}
  </g>`;
}

function donutPath(cx, cy, radius, startAngle, endAngle) {
  const start = {
    x: cx + radius * Math.cos(startAngle),
    y: cy + radius * Math.sin(startAngle),
  };
  const end = {
    x: cx + radius * Math.cos(endAngle),
    y: cy + radius * Math.sin(endAngle),
  };
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function renderLanguages(model) {
  const cx = 760;
  const cy = 610;
  const radius = 64;
  let angle = -Math.PI / 2;
  const slices = model.languages.slices;
  const arcs = slices.length === 1
    ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${slices[0].color}" stroke-width="18"/>`
    : slices.map((slice) => {
      const sweep = (slice.tenths / 1000) * Math.PI * 2;
      const path = sweep <= 0 ? "" : `<path d="${donutPath(cx, cy, radius, angle, angle + sweep)}" fill="none" stroke="${slice.color}" stroke-width="18"/>`;
      angle += sweep;
      return path;
    }).join("");
  const legend = slices.length
    ? slices.map((slice, index) => {
      const y = 560 + index * 26;
      return `<circle cx="900" cy="${y - 4}" r="5" fill="${slice.color}"/>
        <text x="914" y="${y}" fill="#F5F0F2" font-size="13" font-family="${SANS}">${escapeXml(slice.name)}</text>
        <text data-language="${escapeXml(slice.name)}" x="1120" y="${y}" text-anchor="end" fill="#B7AAB1" font-size="13" font-family="${SANS}">${escapeXml(slice.percentLabel)}</text>`;
    }).join("")
    : `<text x="900" y="680" fill="#B7AAB1" font-size="13" font-family="${SANS}">No language bytes were returned.</text>`;
  return `<g>
    <rect x="608" y="462" width="568" height="270" rx="18" fill="#1B1018" stroke="#43202F"/>
    <text x="628" y="492" fill="#F5F0F2" font-size="18" font-weight="650" font-family="${SANS}">Language distribution</text>
    <text x="628" y="512" fill="#B7AAB1" font-size="12" font-family="${SANS}">Repository bytes, not proficiency</text>
    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#2A1520" stroke-width="18"/>
    ${arcs}
    <text x="${cx}" y="${cy + 6}" text-anchor="middle" fill="#EF355D" font-family="${MONO}" font-size="16">&lt;/&gt;</text>
    ${legend}
  </g>`;
}

function renderFooter(model) {
  const privateNote = model.restrictedContributions > 0
    ? `Private contributions reported in this window: ${formatCount(model.restrictedContributions)}. They are included in the calendar total.`
    : "Private contributions are included only when GitHub returns them for this token.";
  const lines = [
    `Source: GitHub GraphQL contributionsCollection for ${model.login}, ${model.from} to ${model.to}.`,
    "Contributions are the calendar total. Commits were authored in the window. Pull requests and issues were opened in the window.",
    privateNote,
    "Repository and star counts are public owned repositories, excluding forks. Language percentages are Linguist bytes, not proficiency.",
  ];
  return lines.map((line, index) => (
    `<text x="24" y="${756 + index * 16}" fill="#8C7B84" font-size="11" font-family="${SANS}">${escapeXml(line)}</text>`
  )).join("");
}

function assertRenderable(svg) {
  if (!svg.includes("<svg") || !svg.trimEnd().endsWith("</svg>") || /\bNaN\b|Infinity/.test(svg)) {
    throw new Error("The analytics image failed validation. The existing file was left unchanged.");
  }
  const bareAmpersands = svg.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, "");
  if (bareAmpersands.includes("&") || bareAmpersands.includes("<script")) {
    throw new Error("The analytics image failed validation. The existing file was left unchanged.");
  }
}

export function renderAnalyticsSvg(model) {
  const cards = [
    ["repositories", "Repositories", "Public, forks excluded", formatCount(model.repositories), "repositories"],
    ["contributions", "Contributions", "Last 12 months", formatCount(model.contributions), "contributions"],
    ["commits", "Commits", "Last 12 months", formatCount(model.commits), "commits"],
    ["pulls", "Pull requests", "Opened, 12 months", formatCount(model.pullRequests), "pullRequests"],
    ["issues", "Issues", "Opened, 12 months", formatCount(model.issues), "issues"],
    ["stars", "Stars", "Public owned repos", formatCount(model.stars), "stars"],
  ].map((item, index) => metricCard(24 + index * 194, 88, {
    icon: item[0], label: item[1], subtitle: item[2], value: item[3], metric: item[4],
  })).join("");

  const result = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="830" viewBox="0 0 1200 830" role="img" aria-labelledby="analyticsTitle analyticsDesc" data-analytics-state="live">
  <title id="analyticsTitle">GitHub analytics for ${escapeXml(model.login)}</title>
  <desc id="analyticsDesc">Public repositories, contribution calendar, streaks, monthly activity, and language byte distribution for ${escapeXml(model.from)} to ${escapeXml(model.to)}.</desc>
  <defs>
    <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#EF355D" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#EF355D" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="830" fill="#0D0A10"/>
  <rect x="0" y="0" width="1200" height="3" fill="#EF355D"/>
  <text x="24" y="42" fill="#F5F0F2" font-size="26" font-weight="700" font-family="${SANS}">GitHub Analytics</text>
  <text x="24" y="66" fill="#B7AAB1" font-size="13" font-family="${SANS}">Trailing year of GitHub contribution data for ${escapeXml(model.login)}</text>
  ${cards}
  ${renderHeatmap(model)}
  ${renderStreak(model)}
  ${renderActivity(model)}
  ${renderLanguages(model)}
  ${renderFooter(model)}
</svg>
`;
  assertRenderable(result);
  return result;
}

export function renderPlaceholderSvg() {
  const labels = [
    ["repositories", "Repositories", "Public, forks excluded"],
    ["contributions", "Contributions", "Trailing year"],
    ["commits", "Commits", "Trailing year"],
    ["pulls", "Pull requests", "Opened in the window"],
    ["issues", "Issues", "Opened in the window"],
    ["stars", "Stars", "Public owned repos"],
  ];
  const cards = labels.map((item, index) => `<g>
    <rect x="${24 + index * 194}" y="88" width="182" height="112" rx="16" fill="#1B1018" stroke="#43202F"/>
    ${icon(item[0], 38 + index * 194, 102)}
    <text x="${70 + index * 194}" y="116" fill="#F5F0F2" font-size="13" font-family="${SANS}">${escapeXml(item[1])}</text>
    <text x="${70 + index * 194}" y="134" fill="#B7AAB1" font-size="11" font-family="${SANS}">${escapeXml(item[2])}</text>
    <text x="${40 + index * 194}" y="178" fill="#8C7B84" font-size="18" font-family="${SANS}">Awaiting data</text>
  </g>`).join("");
  const panels = [
    [24, 216, 748, 230, "Contribution activity"],
    [788, 216, 388, 230, "Contribution streak"],
    [24, 462, 568, 270, "Activity overview"],
    [608, 462, 568, 270, "Language distribution"],
  ].map(([x, y, w, h, title]) => `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#1B1018" stroke="#43202F"/>
    <text x="${x + 20}" y="${y + 32}" fill="#F5F0F2" font-size="18" font-family="${SANS}">${escapeXml(title)}</text>
    <text x="${x + 20}" y="${y + 64}" fill="#B7AAB1" font-size="13" font-family="${SANS}">Awaiting data</text>
  </g>`).join("");

  const result = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="830" viewBox="0 0 1200 830" role="img" aria-labelledby="analyticsTitle analyticsDesc" data-analytics-state="placeholder">
  <title id="analyticsTitle">GitHub analytics placeholder</title>
  <desc id="analyticsDesc">Live GitHub analytics have not been generated yet. This image contains no counts or percentages.</desc>
  <rect width="1200" height="830" fill="#0D0A10"/>
  <rect x="0" y="0" width="1200" height="3" fill="#EF355D"/>
  <text x="24" y="42" fill="#F5F0F2" font-size="26" font-weight="700" font-family="${SANS}">GitHub Analytics</text>
  <text x="24" y="66" fill="#B7AAB1" font-size="13" font-family="${SANS}">Live statistics have not been generated.</text>
  ${cards}
  ${panels}
  <text x="24" y="756" fill="#8C7B84" font-size="11" font-family="${SANS}">Configure the repository secret, then run the analytics workflow. This image will be replaced with data from the GitHub API.</text>
  <text x="24" y="772" fill="#8C7B84" font-size="11" font-family="${SANS}">No repository counts, contribution totals, or language percentages are shown in this placeholder.</text>
</svg>
`;
  assertRenderable(result);
  return result;
}

function scrub(message, token) {
  if (!token || typeof message !== "string") return message;
  return message.split(token).join("[redacted]");
}

async function graphql(fetchImpl, token, query, variables) {
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "roshelpeter-cpu-analytics",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network failure";
    throw new Error(`GitHub API request failed (${scrub(reason, token)}). The existing analytics image was left unchanged.`);
  }
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`GitHub API returned a non-JSON response (${response.status}). The existing analytics image was left unchanged.`);
  }
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const rateLimited = response.status === 429
    || errors.some((error) => error?.type === "RATE_LIMITED" || /rate limit/i.test(error?.message ?? ""))
    || /rate limit/i.test(body.message ?? "");
  if (rateLimited) {
    throw new Error("GitHub API rate limit reached. The existing analytics image was left unchanged.");
  }
  if (!response.ok || errors.length > 0 || !body.data) {
    throw new Error(`GitHub API request failed (${response.status}). The existing analytics image was left unchanged.`);
  }
  return body.data;
}

async function fetchRepositories(fetchImpl, token, login) {
  const nodes = [];
  let after = null;
  let totalCount = null;
  const seen = new Set();
  for (let page = 0; page < MAX_REPO_PAGES; page += 1) {
    if (after) {
      if (seen.has(after)) throw new Error("Repository pagination did not advance. The existing analytics image was left unchanged.");
      seen.add(after);
    }
    const data = await graphql(fetchImpl, token, REPOSITORIES_QUERY, { login, after });
    const connection = data?.user?.repositories;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new Error("Repository data was incomplete. The existing analytics image was left unchanged.");
    }
    if (totalCount == null) totalCount = connection.totalCount;
    else if (connection.totalCount !== totalCount) {
      throw new Error("Repository data changed during pagination. The existing analytics image was left unchanged.");
    }
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) {
      return { totalCount, nodes };
    }
    after = connection.pageInfo.endCursor;
    if (!after) throw new Error("Repository pagination did not advance. The existing analytics image was left unchanged.");
  }
  throw new Error("Repository data was incomplete. The existing analytics image was left unchanged.");
}

function writeBufferAtomically(dest, buffer) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  const backup = `${dest}.${process.pid}.bak`;
  writeFileSync(tmp, buffer);
  const written = readFileSync(tmp);
  if (!written.equals(buffer)) {
    unlinkSync(tmp);
    throw new Error("The analytics image could not be written safely. The existing file was left unchanged.");
  }
  const hadDest = existsSync(dest);
  try {
    if (hadDest) renameSync(dest, backup);
    renameSync(tmp, dest);
    if (hadDest && existsSync(backup)) unlinkSync(backup);
  } catch (error) {
    if (!existsSync(dest) && existsSync(backup)) {
      try { renameSync(backup, dest); } catch { /* restore is best-effort */ }
    }
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* temporary file cleanup */ }
    }
    throw error;
  }
}

export function writeSvgAtomically(dest, svg) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  const backup = `${dest}.${process.pid}.bak`;
  writeFileSync(tmp, svg, "utf8");
  if (readFileSync(tmp, "utf8") !== svg) {
    unlinkSync(tmp);
    throw new Error("The analytics image could not be written safely. The existing file was left unchanged.");
  }
  const hadDest = existsSync(dest);
  try {
    if (hadDest) renameSync(dest, backup);
    renameSync(tmp, dest);
    if (hadDest && existsSync(backup)) unlinkSync(backup);
  } catch (error) {
    if (!existsSync(dest) && existsSync(backup)) {
      try { renameSync(backup, dest); } catch { /* restore is best-effort */ }
    }
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* temporary file cleanup */ }
    }
    throw error;
  }
}

const WIDGET_COLORS = {
  light: { bg: "#ffffff", text: "#24292f", muted: "#57606a", line: "#d0d7de", accent: "#0969da" },
  dark: { bg: "#0d1117", text: "#e6edf3", muted: "#8b949e", line: "#30363d", accent: "#58a6ff" },
};

const LANGUAGE_COLORS = ["#0969da", "#8250df", "#bf3989", "#1a7f37", "#9a6700", "#6e7781"];

function widgetSvg(width, height, title, description, body, theme = "light") {
  const colors = WIDGET_COLORS[theme] ?? WIDGET_COLORS.light;
  const result = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="widgetTitle widgetDesc" data-analytics-state="live">
  <title id="widgetTitle">${title}</title>
  <desc id="widgetDesc">${description}</desc>
  <rect width="${width}" height="${height}" rx="12" fill="${colors.bg}" stroke="${colors.line}"/>
  ${body}
</svg>`;
  assertRenderable(result);
  return result;
}

function renderStatsWidgetSvg(model) {
  const colors = WIDGET_COLORS.light;
  const rows = [
    ["repositories", "Public repositories", model.repositories],
    ["contributions", "Contributions", model.contributions],
    ["commits", "Commit contributions", model.commits],
    ["pullRequests", "Pull request contributions", model.pullRequests],
    ["issues", "Issue contributions", model.issues],
    ["stars", "Stars on public repositories", model.stars],
  ];
  const lines = rows.map((row, index) => {
    const y = 92 + index * 28;
    return `<text x="24" y="${y}" fill="${colors.muted}" font-size="14" font-family="${SANS}">${escapeXml(row[1])}</text>
      <text data-metric="${row[0]}" x="496" y="${y}" text-anchor="end" fill="${colors.text}" font-size="16" font-weight="700" font-family="${SANS}">${escapeXml(formatCount(row[2]))}</text>`;
  }).join("");
  return widgetSvg(520, 268, escapeXml(`GitHub statistics for ${model.login}`), escapeXml(`Counts for ${model.from} to ${model.to}.`), `
    <text x="24" y="36" fill="${colors.text}" font-size="20" font-weight="700" font-family="${SANS}">GitHub statistics</text>
    <text x="24" y="58" fill="${colors.muted}" font-size="12" font-family="${SANS}">${escapeXml(model.from.slice(0, 10))} to ${escapeXml(model.to.slice(0, 10))}</text>
    ${lines}
  `);
}

function renderLanguagesWidgetSvg(model) {
  const colors = WIDGET_COLORS.light;
  const slices = model.languages.slices;
  const rows = slices.length
    ? slices.map((slice, index) => {
      const y = 86 + index * 32;
      const width = Math.max(2, Math.round((slice.tenths / 1000) * 280));
      return `<rect x="24" y="${y - 12}" width="${width}" height="10" rx="5" fill="${LANGUAGE_COLORS[index % LANGUAGE_COLORS.length]}"/>
        <text x="316" y="${y}" fill="${colors.text}" font-size="14" font-family="${SANS}">${escapeXml(slice.name)}</text>
        <text data-language="${escapeXml(slice.name)}" x="616" y="${y}" text-anchor="end" fill="${colors.muted}" font-size="14" font-family="${SANS}">${escapeXml(slice.percentLabel)}</text>`;
    }).join("")
    : `<text x="24" y="100" fill="${colors.muted}" font-size="14" font-family="${SANS}">No language bytes were returned.</text>`;
  return widgetSvg(640, Math.max(180, 110 + slices.length * 32), escapeXml("Repository language distribution"), escapeXml("Linguist byte share of public owned repositories, not a proficiency ranking."), `
    <text x="24" y="36" fill="${colors.text}" font-size="20" font-weight="700" font-family="${SANS}">Repository languages</text>
    <text x="24" y="58" fill="${colors.muted}" font-size="12" font-family="${SANS}">Share of code bytes in public owned repositories. This is not a proficiency ranking.</text>
    ${rows}
  `);
}

export async function runAnalytics({
  token = process.env.METRICS_TOKEN,
  login = PROFILE_LOGIN,
  dest = null,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("METRICS_TOKEN is not set. The existing analytics image was left unchanged.");
  }
  const viewer = await graphql(fetchImpl, token, VIEWER_QUERY, {});
  if (!viewer?.viewer?.login || viewer.viewer.login.toLowerCase() !== login.toLowerCase()) {
    throw new Error("METRICS_TOKEN does not belong to roshelepeter-cpu. The existing analytics image was left unchanged.");
  }
  const window = contributionWindow(now);
  const contributionData = await graphql(fetchImpl, token, CONTRIBUTIONS_QUERY, {
    login,
    from: window.from,
    to: window.to,
  });
  const repositories = await fetchRepositories(fetchImpl, token, login);
  const model = normalizeApiPayload({
    login,
    from: window.from,
    to: window.to,
    totalCount: repositories.totalCount,
    nodes: repositories.nodes,
    collection: contributionData?.user?.contributionsCollection,
  });
  const svg = renderAnalyticsSvg(model);
  if (!svg.includes('data-analytics-state="live"') || svg.includes(token)) {
    throw new Error("The analytics image failed validation. The existing file was left unchanged.");
  }
  if (dest) {
    writeSvgAtomically(dest, svg);
    return { dest, model };
  }
  const outputs = defaultAnalyticsOutputs();
  const documents = [
    [outputs.stats, renderStatsWidgetSvg(model)],
    [outputs.languages, renderLanguagesWidgetSvg(model)],
  ];
  for (const [, document] of documents) {
    if (!document.includes('data-analytics-state="live"') || document.includes(token)) {
      throw new Error("The analytics image failed validation. The existing file was left unchanged.");
    }
  }
  for (const [file, document] of documents) writeSvgAtomically(file, document);
  return { dest: outputs.stats, outputs, model };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  runAnalytics()
    .then((result) => {
      console.log(`Updated GitHub analytics for ${result.model.login} (${result.model.from} to ${result.model.to}).`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Analytics generation failed.";
      console.error(scrub(message, process.env.METRICS_TOKEN));
      process.exitCode = 1;
    });
}
