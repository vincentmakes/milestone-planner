{# Shown above the print page on screen only (the plugin hides it in print). #}
<p>
    This page holds the whole <strong>User Guide</strong> and <strong>Admin Guide</strong> in one.
    To keep a copy, use your browser's <strong>Print</strong> dialog (<kbd>Ctrl</kbd>+<kbd>P</kbd>, or <kbd>⌘</kbd>+<kbd>P</kbd> on a Mac)
    and choose <strong>Save as PDF</strong>.
</p>
{% if config.extra.manual_pdf_url %}
<p>
    Or <a href="{{ config.extra.manual_pdf_url }}">download the manual as PDF</a>,
    rebuilt with every update of the manual.
</p>
{% endif %}
