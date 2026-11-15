import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  calculateStreaks,
  contributionWindow,
  escapeXml,
  heatmapLayout,
  languageDistribution,
  monthlyTotals,
  normalizeApiPayload,
  renderAnalyticsSvg,
  renderPlaceholderSvg,
  runAnalytics,
} from "./generate-github-analytics.mjs";

const TOKEN = "test-metrics-token";

function textNodes(svg) {
  return [...svg.matchAll(/>([^<]*)</g)].map((match) => match[1]).filter((text) => text.trim() !== "");
}

function day(date, count, weekday = 0, level = count > 0 ? "SECOND_QUARTILE" : "NONE") {
  return { date, weekday, contributionCount: count, contributionLevel: level };
}

function week(firstDay, days) {
  return { firstDay, contributionDays: days };
}

test("escapeXml encodes every character that would break SVG text", () => {
  assert.equal(escapeXml(`A&B<C>D"E'F`), "A&amp;B&lt;C&gt;D&quot;E&apos;F");
});

test("contribution window stays strictly under 365 days", () => {
  for (const iso of ["2024-03-01T00:00:00Z", "2026-02-28T18:30:00Z", "2026-11-15T12:00:00Z"]) {
    const window = contributionWindow(new Date(iso));
    const span = Date.parse(window.to) - Date.parse(window.from);
    assert.ok(span > 0);
    assert.ok(span < 365 * 24 * 60 * 60 * 1000);
  }
});

test("current streak treats an empty today as still active and stops after a gap", () => {
  const active = calculateStreaks([
    { date: "2026-11-10", count: 0 },
    { date: "2026-11-12", count: 2 },
    { date: "2026-11-13", count: 1 },
    { date: "2026-11-14", count: 4 },
    { date: "2026-11-15", count: 0 },
  ]);
  assert.deepEqual(active, { current: 3, longest: 3, currentIsCensored: false });

  const ended = calculateStreaks([
    { date: "2026-11-12", count: 2 },
    { date: "2026-11-13", count: 1 },
    { date: "2026-11-14", count: 0 },
    { date: "2026-11-15", count: 0 },
  ]);
  assert.equal(ended.current, 0);
  assert.equal(ended.longest, 2);

  const today = calculateStreaks([
    { date: "2026-11-13", count: 4 },
    { date: "2026-11-14", count: 0 },
    { date: "2026-11-15", count: 2 },
  ]);
  assert.equal(today.current, 1);
  assert.equal(today.longest, 1);

  const gap = calculateStreaks([
    { date: "2026-11-13", count: 1 },
    { date: "2026-11-15", count: 1 },
  ]);
  assert.equal(gap.current, 1);
  assert.equal(gap.longest, 1);

  assert.deepEqual(calculateStreaks([]), { current: 0, longest: 0, currentIsCensored: false });
});

test("a streak that reaches the first returned day is marked as censored", () => {
  const streak = calculateStreaks([
    { date: "2026-11-13", count: 1 },
    { date: "2026-11-14", count: 2 },
    { date: "2026-11-15", count: 0 },
  ]);
  assert.equal(streak.current, 2);
  assert.equal(streak.currentIsCensored, true);
  assert.throws(() => calculateStreaks([
    { date: "2026-11-14", count: 1 },
    { date: "2026-11-14", count: 2 },
  ]), /Duplicate contribution date/);
});

test("monthly totals ignore days outside the window and keep empty months", () => {
  const months = monthlyTotals([
    { date: "2025-12-31", count: 9 },
    { date: "2026-01-15", count: 2 },
    { date: "2026-01-20", count: 3 },
    { date: "2026-02-01", count: 4 },
    { date: "2026-03-02", count: 1 },
  ], "2026-01-01", "2026-03-15");
  assert.deepEqual(months.map((month) => [month.key, month.total]), [
    ["2026-01", 5],
    ["2026-02", 4],
    ["2026-03", 1],
  ]);
  assert.equal(months.reduce((sum, month) => sum + month.total, 0), 10);
});

test("language percentages use the largest remainder method and roll the tail into Other", () => {
  const even = languageDistribution([
    { languages: [{ name: "TypeScript", size: 1 }, { name: "JavaScript", size: 1 }, { name: "PHP", size: 1 }] },
  ]);
  assert.deepEqual(even.slices.map((slice) => slice.percentLabel), ["33.4%", "33.3%", "33.3%"]);
  assert.equal(even.slices.reduce((sum, slice) => sum + slice.tenths, 0), 1000);

  const many = languageDistribution([
    { languages: ["C", "C++", "CSS", "HTML", "JavaScript", "PHP", "Python"].map((name) => ({ name, size: 10 })) },
  ]);
  assert.equal(many.slices.length, 6);
  assert.equal(many.slices.at(-1).name, "Other");
  assert.equal(many.slices.at(-1).percentLabel, "28.5%");
  assert.equal(many.slices.reduce((sum, slice) => sum + slice.tenths, 0), 1000);
  assert.deepEqual(languageDistribution([{ languages: [] }]), { totalBytes: 0, slices: [] });
});

test("heatmap places Monday on the second row and labels the first of a month", () => {
  const layout = heatmapLayout([
    {
      contributionDays: [
        { date: "2026-03-01", weekday: 0, count: 0, level: "NONE" },
        { date: "2026-03-02", weekday: 1, count: 2, level: "SECOND_QUARTILE" },
      ],
    },
  ], { originX: 10, originY: 20, cell: 10, gap: 3 });
  const monday = layout.cells.find((cell) => cell.date === "2026-03-02");
  assert.equal(monday.y, 20 + 13);
  assert.equal(layout.monthLabels[0].text, "Mar");
  assert.equal(layout.monthLabels[0].x, 10);

  const spaced = heatmapLayout([
    { contributionDays: [{ date: "2025-11-16", weekday: 0, count: 0, level: "NONE" }] },
    { contributionDays: [{ date: "2025-11-23", weekday: 0, count: 0, level: "NONE" }] },
    { contributionDays: [{ date: "2025-12-01", weekday: 1, count: 1, level: "FIRST_QUARTILE" }] },
  ]);
  assert.deepEqual(spaced.monthLabels.map((label) => label.text), ["Nov", "Dec"]);
});

test("placeholder text contains no numeric statistics", () => {
  const svg = renderPlaceholderSvg();
  assert.match(svg, /data-analytics-state="placeholder"/);
  assert.match(svg, /Live statistics have not been generated/);
  for (const text of textNodes(svg)) assert.doesNotMatch(text, /\d/);
});

test("rendered analytics escape API text and expose the calculated figures", () => {
  const model = normalizeApiPayload({
    login: "roshelpeter-cpu",
    from: "2026-11-10T00:00:00Z",
    to: "2026-11-15T00:00:00Z",
    totalCount: 1,
    nodes: [{
      name: "PerformX-360",
      stargazerCount: 4,
      languages: {
        pageInfo: { hasNextPage: false },
        edges: [
          { size: 2, node: { name: "TypeScript" } },
          { size: 1, node: { name: "<script>" } },
        ],
      },
    }],
    collection: {
      restrictedContributionsCount: 0,
      totalCommitContributions: 5,
      totalIssueContributions: 1,
      totalPullRequestContributions: 2,
      contributionCalendar: {
        totalContributions: 7,
        weeks: [week("2026-11-09", [
          day("2026-11-10", 0, 2),
          day("2026-11-12", 2, 4),
          day("2026-11-13", 1, 5),
          day("2026-11-14", 4, 6, "FOURTH_QUARTILE"),
          day("2026-11-15", 0, 0),
        ])],
      },
    },
  });
  const svg = renderAnalyticsSvg(model);
  assert.match(svg, /data-analytics-state="live"/);
  assert.match(svg, /data-metric="contributions"[^>]*>7</);
  assert.match(svg, /data-metric="commits"[^>]*>5</);
  assert.match(svg, /data-metric="stars"[^>]*>4</);
  assert.match(svg, /data-streak="current"[^>]*>3</);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /fill="#EF355D"/);
  assert.match(svg, /fill="#2A1520"/);
});

test("incomplete or failed API responses do not replace an existing image", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "analytics-"));
  const dest = path.join(directory, "github-analytics.svg");
  writeFileSync(dest, "KEEP");

  async function expectUnchanged(fetchImpl) {
    await assert.rejects(() => runAnalytics({
      token: TOKEN,
      dest,
      fetchImpl,
      now: new Date("2026-11-15T12:00:00Z"),
    }));
    assert.equal(readFileSync(dest, "utf8"), "KEEP");
  }

  await expectUnchanged(async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: "Bad credentials" }) }));
  await expectUnchanged(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
  }));
  await expectUnchanged(async (_url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes("viewer")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { viewer: { login: "someone-else" } } }) };
    }
    throw new Error("should not continue");
  });
  await assert.rejects(() => runAnalytics({ token: "   ", dest, fetchImpl: async () => { throw new Error("no network"); } }));
  assert.equal(readFileSync(dest, "utf8"), "KEEP");
});

test("a successful run writes only after a complete response and never embeds the token", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "analytics-"));
  const dest = path.join(directory, "github-analytics.svg");
  writeFileSync(dest, "KEEP");
  let repoCalls = 0;

  const fetchImpl = async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    const { query, variables } = JSON.parse(options.body);
    if (query.includes("viewer { login }")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { viewer: { login: "RoshelPeter-CPU" } } }) };
    }
    if (query.includes("contributionsCollection")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            user: {
              contributionsCollection: {
                restrictedContributionsCount: 0,
                totalCommitContributions: 5,
                totalIssueContributions: 1,
                totalPullRequestContributions: 2,
                contributionCalendar: {
                  totalContributions: 7,
                  weeks: [week("2026-11-09", [
                    day("2026-11-10", 0, 2),
                    day("2026-11-12", 2, 4),
                    day("2026-11-13", 1, 5),
                    day("2026-11-14", 4, 6, "FOURTH_QUARTILE"),
                    day("2026-11-15", 0, 0),
                  ])],
                },
              },
            },
          },
        }),
      };
    }
    repoCalls += 1;
    if (!variables.after) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            user: {
              repositories: {
                totalCount: 2,
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                nodes: [{
                  name: "Eventra",
                  stargazerCount: 3,
                  languages: { pageInfo: { hasNextPage: false }, edges: [{ size: 50, node: { name: "JavaScript" } }] },
                }],
              },
            },
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          user: {
            repositories: {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                name: "PerformX-360",
                stargazerCount: 1,
                languages: { pageInfo: { hasNextPage: false }, edges: [{ size: 50, node: { name: "TypeScript" } }] },
              }],
            },
          },
        },
      }),
    };
  };

  const failingPage = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    if (query.includes("viewer")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { viewer: { login: "roshelpeter-cpu" } } }) };
    }
    if (query.includes("contributionsCollection")) {
      return fetchImpl(_url, options);
    }
    if (!variables.after) return fetchImpl(_url, options);
    return { ok: false, status: 502, text: async () => JSON.stringify({ message: "bad gateway" }) };
  };

  await assert.rejects(() => runAnalytics({
    token: TOKEN,
    dest,
    fetchImpl: failingPage,
    now: new Date("2026-11-15T12:00:00Z"),
  }));
  assert.equal(readFileSync(dest, "utf8"), "KEEP");

  const result = await runAnalytics({
    token: TOKEN,
    dest,
    fetchImpl,
    now: new Date("2026-11-15T12:00:00Z"),
  });
  const svg = readFileSync(dest, "utf8");
  assert.equal(repoCalls >= 2, true);
  assert.equal(result.model.repositories, 2);
  assert.equal(result.model.stars, 4);
  assert.equal(result.model.streaks.current, 3);
  assert.equal(result.model.months.at(-1).total, 7);
  assert.match(svg, /data-metric="repositories"[^>]*>2</);
  assert.doesNotMatch(svg, new RegExp(TOKEN));
  assert.equal(svg.includes("KEEP"), false);
});
