const CONNECTOR_RELEASES_URL =
	"https://api.github.com/repos/camunda/connectors/releases?per_page=100";

const marketplaceUrl = process.env.C8CTL_OOTB_ELEMENT_TEMPLATES_URL;
if (!marketplaceUrl) {
	throw new Error(
		"C8CTL_OOTB_ELEMENT_TEMPLATES_URL is required for the connector release mock.",
	);
}

const fixtureReleasesUrl = new URL("/releases", marketplaceUrl);
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
	const url =
		input instanceof Request
			? input.url
			: input instanceof URL
				? input.href
				: input;
	if (url === CONNECTOR_RELEASES_URL) {
		return originalFetch(fixtureReleasesUrl, init);
	}
	return originalFetch(input, init);
};
