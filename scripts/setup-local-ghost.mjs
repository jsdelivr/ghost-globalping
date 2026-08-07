import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ghostPort = process.env.GHOST_PORT ?? '2368';
const ghostUrl = new URL(process.env.GHOST_URL ?? `http://localhost:${ghostPort}`).origin;
const stateRoot = path.resolve('.ghost-local');
const stateDirectory = path.resolve(process.env.GHOST_STATE_DIR ?? stateRoot);
const credentialsPath = path.join(stateDirectory, 'admin.json');
const fixturePath = path.resolve(process.env.GHOST_FIXTURE_PATH ?? '.ghost-local/globalping-public.json');
const adminEmail = 'local@globalping.test';
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const relativeStateDirectory = path.relative(stateRoot, stateDirectory);

if (!allowedHosts.has(new URL(ghostUrl).hostname)) {
	throw new Error(`Refusing to configure a non-local Ghost instance: ${ghostUrl}`);
}

if (relativeStateDirectory.startsWith('..') || path.isAbsolute(relativeStateDirectory)) {
	throw new Error(`GHOST_STATE_DIR must stay within the ignored ${stateRoot} directory.`);
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const fetchGhost = (pathname, options = {}, timeout = 30_000) => fetch(new URL(pathname, `${ghostUrl}/`), {
	...options,
	headers: {
		'Accept-Version': 'v5.0',
		...options.headers,
	},
	signal: AbortSignal.timeout(timeout),
});

const assertOk = async (response, action) => {
	if (response.ok) {
		return response;
	}

	const body = (await response.text()).replace(/\s+/g, ' ').trim();
	throw new Error(`${action} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`);
};

const waitForGhost = async () => {
	const deadline = Date.now() + 90_000;
	let lastError;

	while (Date.now() < deadline) {
		try {
			const response = await fetchGhost('/ghost/api/admin/authentication/setup/', {}, 5_000);
			await assertOk(response, 'Ghost readiness check');
			const data = await response.json();
			return Boolean(data.setup?.[0]?.status);
		} catch (error) {
			lastError = error;
			await delay(1_000);
		}
	}

	throw new Error(`Ghost did not become ready at ${ghostUrl}: ${lastError?.message ?? 'timed out'}`);
};

const readCredentials = async () => {
	try {
		const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));

		if (typeof credentials.email !== 'string' || typeof credentials.password !== 'string') {
			throw new Error('email and password must be strings');
		}

		return credentials;
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}

		throw new Error(`Unable to read ${credentialsPath}: ${error.message}`);
	}
};

const createCredentials = async () => {
	const credentials = {
		email: adminEmail,
		password: `Gp1!${randomBytes(24).toString('base64url')}`,
	};

	await mkdir(stateDirectory, { recursive: true });
	await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});

	return credentials;
};

const readFixture = async () => {
	const contents = await readFile(fixturePath);
	let fixture;

	try {
		fixture = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Unable to parse ${fixturePath}: ${error.message}`);
	}

	const postSlugs = fixture.data?.posts
		?.filter(post => post.type === 'post' && typeof post.slug === 'string')
		.map(post => post.slug);

	if (!postSlugs?.length) {
		throw new Error(`${fixturePath} does not contain any posts.`);
	}

	return { contents, postSlugs };
};

const createOwner = async credentials => {
	const response = await fetchGhost('/ghost/api/admin/authentication/setup/', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			setup: [{
				name: 'Globalping Local',
				email: credentials.email,
				password: credentials.password,
				blogTitle: 'Globalping Blog (Local)',
			}],
		}),
	});

	await assertOk(response, 'Local owner setup');
};

const signIn = async credentials => {
	const response = await fetchGhost('/ghost/api/admin/session/', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Origin: ghostUrl,
		},
		body: JSON.stringify({
			username: credentials.email,
			password: credentials.password,
		}),
	});

	await assertOk(response, 'Local Ghost sign-in');
	const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
	const cookie = setCookies.map(value => value.split(';', 1)[0]).join('; ');

	if (!cookie) {
		throw new Error('Local Ghost sign-in did not return a session cookie.');
	}

	return cookie;
};

const adminRequest = async (cookie, pathname, options = {}) => {
	const response = await fetchGhost(pathname, {
		...options,
		headers: {
			Cookie: cookie,
			Origin: ghostUrl,
			...options.headers,
		},
	});

	return assertOk(response, `${options.method ?? 'GET'} ${pathname}`);
};

const browsePosts = async (cookie, parameters = {}) => {
	const query = new URLSearchParams(parameters);
	const response = await adminRequest(cookie, `/ghost/api/admin/posts/?${query}`);
	const data = await response.json();
	return data.posts ?? [];
};

const findPost = async (cookie, slug) => {
	const posts = await browsePosts(cookie, {
		filter: `slug:${slug}`,
		limit: '1',
	});
	return posts[0] ?? null;
};

const hasImportedFixture = async (cookie, fixtureSlugs) => {
	const localPosts = await browsePosts(cookie, {
		fields: 'slug',
		limit: 'all',
	});
	const localSlugs = new Set(localPosts.map(post => post.slug));
	return fixtureSlugs.some(slug => localSlugs.has(slug));
};

const deleteDefaultPost = async cookie => {
	const post = await findPost(cookie, 'coming-soon');

	if (post) {
		await adminRequest(cookie, `/ghost/api/admin/posts/${post.id}/`, { method: 'DELETE' });
		console.log('Deleted the default Coming soon post.');
	}
};

const importFixture = async (cookie, fixture) => {
	const form = new FormData();
	form.append('importfile', new Blob([fixture.contents], { type: 'application/json' }), path.basename(fixturePath));

	await adminRequest(cookie, '/ghost/api/admin/db/', {
		method: 'POST',
		body: form,
	});

	const deadline = Date.now() + 60_000;

	while (Date.now() < deadline) {
		if (await hasImportedFixture(cookie, fixture.postSlugs)) {
			console.log(`Imported ${fixturePath}.`);
			return;
		}

		await delay(1_000);
	}

	throw new Error('The imported posts did not appear within 60 seconds.');
};

const activateTheme = async cookie => {
	await adminRequest(cookie, '/ghost/api/admin/themes/globalping/activate/', { method: 'PUT' });
	console.log('Activated the globalping theme.');
};

const verifyHomepage = async cookie => {
	const [latestPost] = await browsePosts(cookie, {
		fields: 'slug',
		filter: 'status:published+tag:-content',
		limit: '1',
		order: 'published_at desc',
	});

	if (!latestPost) {
		throw new Error('Homepage verification could not find a published local post.');
	}

	const response = await fetchGhost('/');
	await assertOk(response, 'Homepage verification');
	const homepage = await response.text();

	if (!homepage.includes(`/${latestPost.slug}/`)) {
		throw new Error(`Homepage verification could not find /${latestPost.slug}/.`);
	}
};

const main = async () => {
	console.log(`Waiting for Ghost at ${ghostUrl}...`);
	const fixture = await readFixture();
	const isSetup = await waitForGhost();
	let credentials = await readCredentials();

	if (!isSetup) {
		credentials ??= await createCredentials();
		await createOwner(credentials);
		console.log('Created the local Ghost owner.');
	} else if (!credentials) {
		throw new Error(`Ghost is already configured, but ${credentialsPath} is missing. Reset the local volume or restore its local credentials.`);
	}

	const cookie = await signIn(credentials);
	const isImported = await hasImportedFixture(cookie, fixture.postSlugs);

	if (isImported) {
		console.log('Public fixture is already imported; skipping import.');
	} else {
		await deleteDefaultPost(cookie);
		await importFixture(cookie, fixture);
	}

	await activateTheme(cookie);
	await verifyHomepage(cookie);

	console.log(`Local Ghost is ready at ${ghostUrl}`);
	console.log(`Admin email: ${credentials.email}`);
	console.log(`Admin password: ${credentials.password}`);
	console.log(`Credentials saved to ${credentialsPath}`);
};

main().catch(error => {
	console.error(`Unable to configure local Ghost: ${error.message}`);
	process.exitCode = 1;
});
