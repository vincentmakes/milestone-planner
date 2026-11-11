{# The print page's cover (mkdocs-print-site-plugin): the product, the manual, the version from /VERSION (docs/hooks/manual_version.py). #}
<div class="milestone-cover">
    <img class="milestone-cover__logo" src="../assets/logo.svg" alt="">
    <h1>{{ config.site_name | replace(" Documentation", "") }}</h1>
    <p class="milestone-cover__subtitle">User and Admin Manual</p>
    <p class="milestone-cover__version">Version {{ config.extra.version }}</p>
    <p class="milestone-cover__note">{{ config.site_description }}</p>
</div>
