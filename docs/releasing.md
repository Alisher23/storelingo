# Releasing storelingo (maintainers)

Releases are published to npm by `.github/workflows/release.yml` when a tag `v<version>` is pushed. The workflow uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with OIDC, so no npm token is stored in the repository, and npm adds a provenance statement to every release.

## One-time setup

Trusted publishing can be configured only for a package that already exists on npm, so the very first version is published by hand.

1. Create an account on [npmjs.com](https://www.npmjs.com/signup) and turn on two-factor authentication.
2. On `main`, with a clean working tree:

   ```bash
   npm login
   npm ci
   npm publish
   ```

   `npm publish` runs the build first (`prepack`) and asks you to confirm in the browser or enter a one-time code.
3. On npmjs.com open the package → **Settings** → **Trusted Publisher** → **GitHub Actions** and enter:
   - Organization or user: `Alisher23`
   - Repository: `storelingo`
   - Workflow filename: `release.yml`
   - Environment: leave empty

   Or from the terminal (npm 11.10 or newer): `npm trust github storelingo --file release.yml --repo Alisher23/storelingo --allow-publish --yes`.
4. On the same page, under **Publishing access**, choose "Require two-factor authentication and disallow tokens". Trusted publishing keeps working.
5. Push the tag for the version you just published (for example `git tag -a v0.5.0 -m v0.5.0 && git push origin v0.5.0`). The workflow sees that this version is already on npm and stops without publishing.

## Every release after that

1. Update `CHANGELOG.md` and bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`), merge to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag -a v<x.y.z> -m v<x.y.z>
   git push origin v<x.y.z>
   ```

3. The workflow checks that the tag matches `package.json`, runs lint, typecheck and tests, and publishes.
4. Create the GitHub release for the tag, and update `@v<x.y.z>` in the GitHub Action examples (`README*.md`, `docs/github-action*.md`).
