type Locale = "en" | "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const translations: Record<Exclude<Locale, "en">, Record<string, string>> = {
	es: {
		"lens.health.title": "🩺 SALUD DE PI-LENS",
		"lens.health.crashes": "Fallos de pipeline (sesión): {count}",
		"lens.health.files": "Archivos afectados: {count}",
		"lens.health.topCrashFiles": "Archivos con más fallos:",
		"lens.health.noLatency": "Aún no hay informes de latencia de dispatch.",
		"lens.health.diagnosticsShown": "Diagnósticos mostrados: {count}",
		"lens.health.autoFixed": "Auto-corregidos: {count}",
		"lens.health.agentFixed": "Corregidos por el agente: {count}",
		"lens.health.unresolved": "Arrastre sin resolver: {count}",
		"lens.health.repeatOffenders": "Infractores repetidos:",
		"lens.health.topNoisyRules": "Reglas más ruidosas:",
	},
	fr: {
		"lens.health.title": "🩺 SANTÉ DE PI-LENS",
		"lens.health.crashes": "Plantages du pipeline (session) : {count}",
		"lens.health.files": "Fichiers concernés : {count}",
		"lens.health.topCrashFiles": "Fichiers avec le plus de plantages :",
		"lens.health.noLatency": "Aucun rapport de latence dispatch pour le moment.",
		"lens.health.diagnosticsShown": "Diagnostics affichés : {count}",
		"lens.health.autoFixed": "Auto-corrigés : {count}",
		"lens.health.agentFixed": "Corrigés par l’agent : {count}",
		"lens.health.unresolved": "Report non résolu : {count}",
		"lens.health.repeatOffenders": "Récidives :",
		"lens.health.topNoisyRules": "Règles les plus bruyantes :",
	},
	"pt-BR": {
		"lens.health.title": "🩺 SAÚDE DO PI-LENS",
		"lens.health.crashes": "Falhas do pipeline (sessão): {count}",
		"lens.health.files": "Arquivos afetados: {count}",
		"lens.health.topCrashFiles": "Arquivos com mais falhas:",
		"lens.health.noLatency": "Ainda não há relatórios de latência do dispatch.",
		"lens.health.diagnosticsShown": "Diagnósticos mostrados: {count}",
		"lens.health.autoFixed": "Corrigidos automaticamente: {count}",
		"lens.health.agentFixed": "Corrigidos pelo agente: {count}",
		"lens.health.unresolved": "Pendências não resolvidas: {count}",
		"lens.health.repeatOffenders": "Infratores recorrentes:",
		"lens.health.topNoisyRules": "Regras mais ruidosas:",
	},
};

let currentLocale: Locale = "en";

export function initI18n(pi: { events?: { emit?: (event: string, payload: unknown) => void } }): void {
	pi.events?.emit?.("pi-core/i18n/registerBundle", { namespace: "pi-lens", defaultLocale: "en", locales: translations });
	pi.events?.emit?.("pi-core/i18n/requestApi", {
		onReady: (api: { getLocale?: () => string; onLocaleChange?: (cb: (locale: string) => void) => void }) => {
			const next = api.getLocale?.();
			if (isLocale(next)) currentLocale = next;
			api.onLocaleChange?.((locale) => { if (isLocale(locale)) currentLocale = locale; });
		},
	});
}

export function t(key: string, fallback: string, params: Params = {}): string {
	const template = currentLocale === "en" ? fallback : translations[currentLocale]?.[key] ?? fallback;
	return template.replaceAll(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

function isLocale(locale: string | undefined): locale is Locale {
	return locale === "en" || locale === "es" || locale === "fr" || locale === "pt-BR";
}
