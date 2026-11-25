import {
	AppStorage as BaseAppStorage,
	CustomProvidersStore,
	getAppStorage,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
} from "@mariozechner/pi-web-ui";
import { DB_NAME } from "./db-name.js";
import { CostStore } from "./stores/cost-store.js";
import { DiscoveredModelsStore } from "./stores/discovered-models-store.js";
import { LocalStudioSessionsStore } from "./stores/sessions-store.js";
import { SkillsStore } from "./stores/skills-store.js";

/**
 * Extended AppStorage for Local Studio with skills, memories, and prompts stores.
 */
export class LocalStudioAppStorage extends BaseAppStorage {
	readonly skills: SkillsStore;
	readonly costs: CostStore;
	readonly discoveredModels: DiscoveredModelsStore;
	/** Every store in the database, by name. */
	readonly storeNames: string[];

	constructor() {
		// 1. Create all stores (no backend yet)
		const settings = new SettingsStore();
		const providerKeys = new ProviderKeysStore();
		const sessions = new LocalStudioSessionsStore();
		const customProviders = new CustomProvidersStore();
		const skills = new SkillsStore();
		const costs = new CostStore();
		const discoveredModels = new DiscoveredModelsStore();

		// 2. Gather configs from all stores
		const configs = [
			settings.getConfig(),
			SessionsStore.getMetadataConfig(),
			providerKeys.getConfig(),
			customProviders.getConfig(),
			sessions.getConfig(),
			skills.getConfig(),
			costs.getConfig(),
			discoveredModels.getConfig(),
		];

		// 3. Create backend with all configs
		const backend = new IndexedDBStorageBackend({
			dbName: DB_NAME,
			version: 4, // v4: discovered-models store
			stores: configs,
		});

		// 4. Wire backend to all stores
		settings.setBackend(backend);
		providerKeys.setBackend(backend);
		customProviders.setBackend(backend);
		sessions.setBackend(backend);
		skills.setBackend(backend);
		costs.setBackend(backend);
		discoveredModels.setBackend(backend);

		// 5. Pass base stores to parent
		super(settings, providerKeys, sessions, customProviders, backend);

		// 6. Store references to local-studio-specific stores
		this.skills = skills;
		this.costs = costs;
		this.discoveredModels = discoveredModels;
		this.storeNames = configs.map((config) => config.name);
	}
}

/**
 * Helper to get typed Local Studio storage.
 */
export function getLocalStudioStorage(): LocalStudioAppStorage {
	return getAppStorage() as LocalStudioAppStorage;
}
