/** Text files bundled by cli/scripts/build.mjs: the release public key and the Local Studio plugins. */
declare module "*.pub" {
	const text: string;
	export default text;
}

declare module "*.md" {
	const text: string;
	export default text;
}

declare module "*.toml" {
	const text: string;
	export default text;
}
