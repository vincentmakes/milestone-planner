{# The print page's cover (mkdocs-print-site-plugin): a left-aligned document cover. The version and the month come from the build (docs/hooks/manual_version.py), the address from site_url; nothing is written in by hand. #}
<div class="milestone-cover">
    <img class="milestone-cover__logo" src="../assets/logo-wordmark.svg" alt="Milestone">
    <div class="milestone-cover__title-block">
        <div class="milestone-cover__rule" aria-hidden="true"></div>
        <h1 class="milestone-cover__title">{{ config.site_name | replace(" Documentation", "") }}</h1>
        <p class="milestone-cover__subtitle">User and Admin Manual</p>
        <p class="milestone-cover__meta">Version {{ config.extra.version }} · {{ config.extra.build_month }}</p>
        <p class="milestone-cover__note">{{ config.extra.cover_description }}</p>
    </div>
    <div class="milestone-cover__foot">
        <span>{{ config.site_url | replace("https://", "") | replace("http://", "") | trim("/") }}</span>
        <span>Licence: FSL-1.1-MIT</span>
    </div>
</div>
