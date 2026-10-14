/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** "1" turns the messaging UI on for every visitor of this build. */
	readonly VITE_FEATURE_MESSAGING?: string;
}
