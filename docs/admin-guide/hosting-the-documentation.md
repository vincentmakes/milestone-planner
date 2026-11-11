# Hosting the Documentation

**Help** in Milestone's user menu opens this manual — by default the home page of the public copy at `https://docs-milestone.verdet.me/`. If your users cannot reach the internet, or you want the manual inside your own network, build it from Milestone's repository, host the result yourself (or publish its PDF on a file share), and point Milestone at it.

The manual is a static site: once built, it is a folder of plain HTML, CSS, JavaScript and image files, with no server-side code and no database. Any web server can serve it.

## 1. Build the manual

You need Python 3 and a checkout of the Milestone repository (the version you run, so the manual matches it).

```bash
pip install -r docs/requirements.txt
mkdocs build --strict
```

The result is the `site/` folder at the repository root. `--strict` stops on a broken link or image instead of publishing a page with holes. `docs/build.sh` runs exactly these two commands; it is what builds the public manual.

!!! tip "`site_url` in `mkdocs.yml`"
    `site_url` is set to the public address. Changing it to your own address is optional — the pages link to each other with relative paths and work at any address. Set it if you want the canonical links and the sitemap to name your host, e.g. `site_url: https://intranet.example.com/milestone-docs/`.

## 2. Serve the `site/` folder

Copy the **contents** of `site/` to any static host. A few ways on Azure follow; [any other static host](#any-other-static-host) works the same way.

### Azure Static Web Apps

Azure has no product called "Azure Pages"; its equivalent of GitHub Pages or Cloudflare Pages is **Azure Static Web Apps**. Create a Static Web App in the Azure portal (the **Free** plan is enough for a public manual; see [Keeping it internal](#keeping-it-internal) for the **Standard** plan), then deploy with either of the two methods below. Both use the app's **deployment token**: in the Azure portal, open the Static Web App, **Overview → Manage deployment token**, or with the Azure CLI:

```bash
az staticwebapp secrets list --name <APP_NAME> --query "properties.apiKey"
```

Never commit the token to a repository.

#### From GitHub Actions

In **your own fork or internal copy** of the repository (not Milestone's repository itself, whose manual is published elsewhere), store the token as the repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN` and add a workflow such as `.github/workflows/docs-azure.yml`. It builds the manual with Python, then hands the prebuilt `site/` folder to the Static Web Apps deploy action, telling it not to build anything itself:

```yaml
name: Manual to Azure Static Web Apps

on:
  push:
    branches: [main]
    paths: ["docs/**", "mkdocs.yml", "CHANGELOG.md"]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Build the manual
        run: |
          pip install -r docs/requirements.txt
          mkdocs build --strict
      - name: Deploy site/
        uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN }}
          action: "upload"
          app_location: "site"     # the prebuilt files
          output_location: ""      # empty with skip_app_build
          skip_app_build: true
          api_location: ""         # no API
```

`CHANGELOG.md` is in this workflow's trigger paths because the site's Release Notes page includes it. (Milestone's own `Manual PDF` workflow does not watch it: the PDF leaves the Developer Guide, and its Release Notes, out.)

#### With the Static Web Apps CLI

To deploy from a workstation or another CI system, install the CLI (it needs Node.js; Microsoft's install page lists the supported versions) and deploy the built folder to the production environment:

```bash
npm install -g @azure/static-web-apps-cli
swa deploy ./site --deployment-token <TOKEN> --env production
```

Instead of `--deployment-token` you can set the token in the `SWA_CLI_DEPLOYMENT_TOKEN` environment variable. Without `--env production` the CLI deploys to a preview environment.

### Azure Storage static website

The simplest option on Azure, if you already have a storage account (general-purpose v2): its **static website** feature serves the files of a container named `$web`. Enable it, upload `site/` and read the address:

```bash
az storage blob service-properties update --account-name <STORAGE_ACCOUNT> \
  --static-website --index-document index.html --404-document 404.html
az storage blob upload-batch -s ./site -d '$web' --account-name <STORAGE_ACCOUNT>
az storage account show -n <STORAGE_ACCOUNT> -g <RESOURCE_GROUP> \
  --query "primaryEndpoints.web" --output tsv
```

Keep `$web` in single quotes, so the shell does not read it as a variable. The manual ships its own `404.html`. The storage static website has no sign-in of its own; see below.

## Keeping it internal

- **Static Web Apps, signing in with Microsoft Entra ID**: a `staticwebapp.config.json` file at the root of the deployed folder (copy it into `site/` after the build, before deploying) can require sign-in for every page:

    ```json
    {
      "routes": [
        { "route": "/*", "allowedRoles": ["authenticated"] }
      ],
      "responseOverrides": {
        "401": { "statusCode": 302, "redirect": "/.auth/login/aad" }
      }
    }
    ```

    The pre-configured Microsoft Entra ID provider lets **any** Microsoft account sign in. To admit only your organisation's tenant, register a custom Microsoft Entra ID provider in the `auth` section of the same file — custom authentication needs the **Standard** plan.
- **Static Web Apps, private network only**: a **private endpoint** makes the app reachable only from your Azure virtual network (and the networks connected to it); it needs the **Standard** plan. The Standard plan's `networking.allowedIpRanges` setting can also limit access to your office address ranges.
- **Storage static website**: it has no sign-in. Keep the storage account behind your private network (private endpoint, firewall rules), or put a gateway that authenticates users in front of it, or use Static Web Apps instead.

## Any other static host

Because the build output is plain files, any web server inside your network works: copy the contents of `site/` to an **nginx** or **Apache** document root, an **IIS** site, an internal file share served over HTTP, or an object store with static-site hosting. Serve `index.html` as the folder index, and `404.html` for missing pages if the server allows it.

## Printing and PDF

Every build has a **print page**, `print_page/` under the manual's home page (`https://intranet.example.com/milestone-docs/print_page/`): the User Guide and the Admin Guide on one page, with a cover naming the version and a table of contents, ready for the browser's **Print → Save as PDF**. It is made by the `mkdocs-print-site-plugin` listed in `docs/requirements.txt`, so a self-hosted build has it too.

To produce the PDF without a browser dialog — the same file the public manual offers — print that page with headless Chromium:

```bash
pip install -r docs/requirements.txt playwright==1.63.0 pdfplumber==0.11.7
python -m playwright install --with-deps chromium
mkdocs build --strict
python scripts/docs/export_manual_pdf.py --site-dir site --output Milestone-Manual.pdf
```

The script serves `site/` on a local port, waits for every screenshot and font, and writes an A4 PDF: a cover with the version and build month, a footer from page 2 on (title, version, page *n* / total), bookmarks for the chapters and their sections, and page numbers in the Contents (it renders the page, reads where each chapter starts, writes the numbers and renders again until they hold). Between renderings it also fixes the layout: a screenshot that would leave most of a page blank is shrunk a little to stay with its heading — by at most a third of its height, so that its text stays legible — and when that is not enough, the text that follows it in its section moves up to fill the page and the screenshot opens the next one, as a typesetter places a figure; a heading stranded at the bottom of a page moves to the next one, and a chapter whose last page would hold only a few lines is tightened or broken earlier so the page carries a proper block. Short paragraphs are kept whole, so a page never holds one lone line of the paragraph before it.

The result depends as little as possible on the machine. Chromium prints unhinted glyphs (`--font-render-hinting=none`): with hinting, as GitHub's runner applied by default, every glyph snaps to a whole pixel, the text runs about 3 % wider and the page breaks move; the script prints which it got. The fonts are the theme's web fonts, Roboto and Roboto Mono, with DejaVu (`fonts-dejavu-core`) and Liberation (`fonts-liberation`) for the few characters they lack — install those two packages for a local run that predicts the published one. The body text is checked against the size the print rules ask for (Chromium shrinks the whole document when something is wider than the page, so the script also breaks long names in table code).

To check that the layout passes cope with other line breaks, `--family` prints the manual under a set of renderings — hinted glyphs, the machine's own fonts instead of the web fonts, text 2 % larger or smaller, letter spacing 1 % wider or narrower — and fails unless every one passes; `--font-hinting`, `--block-web-fonts`, `--text-scale` and `--letter-spacing` give one of them on its own.

It then checks the layout of the PDF it wrote, with `pdfplumber`, and stops with a list of problems when it finds:

- an image cut by a page edge, or text or a box outside the page's text area;
- a heading left at the bottom of a page;
- a page inside a chapter that ends more than a third early (the message names the page and the heading that moved to the next one);
- the last page of a chapter holding fewer than six lines with no image or table;
- a Contents number that does not match its chapter, a body text smaller than the print rules ask for, or fewer pages or bytes than the manual can take.

It also stops when the page does not load or an image is missing, and prints how full each chapter's last page is. The print rules are in `docs/stylesheets/print.css`, which also serves the browser's own **Print** of the print page.

When a page's text changes so that the automatic passes cannot place it well, an author can steer the print layout from the Markdown with two attributes (the `attr_list` extension), which the online manual ignores:

- `{.print-page-break}` on a heading or a paragraph starts it on a new page;
- `{.print-keep-with-next}` keeps a heading or a paragraph on the same page as the block after it.

```markdown
## Keeping it internal {.print-page-break}

The steps below need an administrator: {.print-keep-with-next}
```

Publish the PDF next to your copy of the manual if your users want a download.

## 3. Point Milestone at your copy

In Milestone, open **Settings → Features & defaults** and enter the address Help should open in **Documentation URL** (an administrator, or any role with **Edit instance settings**), then **Save Changes**. See [Settings → Features & defaults](../user-guide/settings.md#features-defaults).

- The address must start with `http://` or `https://`, without spaces or a user name and password, up to 2000 characters.
- It is opened exactly as entered, with nothing appended: your copy's home page (`https://intranet.example.com/milestone-docs/`), or the PDF of the manual on a file share such as SharePoint, with the link's query string and a `#page=` fragment if you like.
- The setting is per workspace: in multi-tenant mode, set it in each workspace that should use your copy.
- Clear the field and save to go back to the public manual.

When you upgrade Milestone, rebuild and redeploy the manual from the same version, so the chapters describe what your users see.
