# Cross-Site View

The **Cross-Site View** provides a high-level overview of projects across the sites you can see, designed for company-wide capacity planning. It needs the *Cross-site view* permission (every built-in role has it) and at least **two** visible sites — with only one, there is nothing to compare and the sidebar does not list it. Administrators see every site; other roles see the sites they belong to, unless the role has *See all sites* (see [Who Sees Which Sites](settings.md#who-sees-which-sites)).

![Cross-Site overview of the visible sites on one timeline](../assets/screenshots/cross-site.png){ loading=lazy }

## How It Works

- **Every site you can see** shows its projects with their real names and customers (unless the Customer field is hidden in [Settings → Project fields](settings.md)); sites you cannot see are not shown at all
- All sites share the same timeline for side-by-side comparison
- Your current site is highlighted with a special indicator
- The header [team filter](settings.md#team-filter) narrows only your current site's lane; the other sites always show all their projects

## Use Cases

- **Resource planning** — Identify capacity across the organization and which projects drive it
- **Timeline alignment** — See how projects at different locations overlap
- **Executive overview** — Quick snapshot of all active work across the company

This view respects organizational boundaries through site visibility: it shows only the sites your account (or a role with *See all sites*) gives you, and projects at the other sites never reach your browser.
