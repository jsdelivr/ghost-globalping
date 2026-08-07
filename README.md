# ghost-jsdelivr-theme
The Ghost theme for jsDelivr's blog


### Compile SASS:

```
$ npx sass --watch assets/styles/scss:assets/styles
```

### Local Ghost preview

Prerequisites:

- Node.js 22
- Docker Desktop with Docker Compose

Create a snapshot of the public Globalping blog content and start Ghost:

```sh
npm run ghost:pull-content
npm run ghost:start
```

Open http://localhost:2368/ghost and complete the one-time local owner setup. In local Ghost Admin:

1. Import `.ghost-local/globalping-public.json` from the Import/Export settings.
2. Open the theme settings and activate the installed `globalping` theme.

The repository is mounted directly as the theme, so edits to existing theme files are available without rebuilding the container. If a newly added theme file is not detected, restart Ghost.

Useful commands:

```sh
npm run ghost:logs
npm run ghost:stop
npm run ghost:start
```

To refresh the preview data, generate a new fixture with `npm run ghost:pull-content`. Import it into a fresh local Ghost database to avoid duplicate posts. Removing the Compose volume is destructive and is intentionally left as an explicit Docker command rather than an npm script.
