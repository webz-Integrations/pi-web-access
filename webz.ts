import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

// Webz.io News Search API: https://docs.webz.io/docs/webz/news-search-api
const WEBZ_SEARCH_URL = "https://api.webz.io/api/news/context";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_REQUEST_RESULTS = 20;
const MAX_DOMAIN_FILTERS = 10;
const COVERAGE_DAYS = 30;
const DAY_MS = 86_400_000;

interface WebSearchConfig {
	webzBaseUrl?: unknown;
	webzApiKey?: unknown;
}

interface WebzArticle {
	url?: unknown;
	title?: unknown;
	summary?: unknown;
}

interface WebzHit {
	article?: WebzArticle;
	chunk?: { text?: unknown };
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	cachedConfig = parsed as WebSearchConfig;
	return cachedConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Webz",
		configuredValue: loadConfig().webzApiKey,
		environmentValue: process.env.WEBZ_API_TOKEN,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"Webz API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "webzApiKey": "your-key" }\n` +
			"  2. Set WEBZ_API_TOKEN environment variable\n" +
			"Get a key at https://webz.io",
		);
	}
	return apiKey;
}

interface DomainFilters {
	include: string[];
	exclude: string[];
}

function parseDomainFilter(domainFilter: string[] | undefined): DomainFilters {
	const filters: DomainFilters = { include: [], exclude: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.exclude : filters.include;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function passesDomainFilters(url: URL, filters: DomainFilters): boolean {
	if (filters.include.length === 0 && filters.exclude.length === 0) return true;
	const hostname = url.hostname.toLowerCase();
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	if (filters.exclude.some(matches)) return false;
	return filters.include.length === 0 || filters.include.some(matches);
}

// The API has no days field. Coverage is the last 30 days, so month and year both use that window.
function publishedFrom(filter: SearchOptions["recencyFilter"]): string | undefined {
	if (!filter) return undefined;
	const days = { day: 1, week: 7, month: COVERAGE_DAYS, year: COVERAGE_DAYS }[filter];
	return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Webz returned invalid response: ${message}`);
}

function envelopeMessage(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parseResponse(value: unknown): WebzHit[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	const detail = envelopeMessage(envelope.detail) || envelopeMessage(envelope.message) || envelopeMessage(envelope.error);
	if (detail) throw invalidResponse(detail);
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected results array");
	return envelope.results as WebzHit[];
}

function snippetOf(entry: WebzHit): string {
	const text = entry.chunk?.text;
	if (typeof text === "string" && text) return text;
	const summary = entry.article?.summary;
	return typeof summary === "string" ? summary : "";
}

export function isWebzAvailable(): boolean {
	return hasCredentialSource({ provider: "Webz", configuredValue: loadConfig().webzApiKey, environmentValue: process.env.WEBZ_API_TOKEN });
}

// Domain filters and recency go to filters.domain, filters.exclude_domain and filters.published_from.
// The key stays in the Authorization header. A non-HTTPS base URL fails in resolveProviderApiUrl before the key is read.
export async function searchWithWebz(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const endpoint = resolveProviderApiUrl("webz", WEBZ_SEARCH_URL, loadConfig().webzBaseUrl);
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const apiFilters: Record<string, unknown> = {};
	if (filters.include.length > 0) apiFilters.domain = filters.include.slice(0, MAX_DOMAIN_FILTERS);
	if (filters.exclude.length > 0) apiFilters.exclude_domain = filters.exclude.slice(0, MAX_DOMAIN_FILTERS);
	const published = publishedFrom(options.recencyFilter);
	if (published) apiFilters.published_from = published;
	const body: Record<string, unknown> = {
		query,
		k: Math.min(MAX_REQUEST_RESULTS, numResults),
	};
	if (Object.keys(apiFilters).length > 0) body.filters = apiFilters;
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: WebzHit[];
	try {
		response = await fetchWithCredentialRedirects(endpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"User-Agent": "pi-web-access",
			},
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Webz error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			// Only a parse failure is invalid JSON; a dropped connection or timeout keeps its own classification.
			if (!(err instanceof SyntaxError)) throw err;
			throw new Error(`Webz returned invalid JSON: ${errorMessage(err)}`);
		}
		entries = parseResponse(rawData);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`Webz request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
			: (() => {
				const redactedMessage = redactCredential(message, apiKey);
				if (redactedMessage === message && err instanceof Error) return err;
				const redactedError = new Error(redactedMessage);
				if (err instanceof Error) redactedError.name = err.name;
				return redactedError;
			})();
		activityMonitor.logError(activityId, redactCredential(errorMessage(outgoing), apiKey));
		throw outgoing;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const article = entry.article;
		if (!article || typeof article !== "object") continue;
		if (typeof article.url !== "string" || !article.url) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(article.url);
		} catch {
			continue;
		}
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (!passesDomainFilters(resultUrl, filters)) continue;
		const title = article.title;
		results.push({
			title: typeof title === "string" && title.trim() ? title.trim() : `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: snippetOf(entry),
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
