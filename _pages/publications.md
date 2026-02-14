---
layout: single
title: "Publications"
permalink: /publications/
author_profile: false
classes: wide
---

<section class="home-section">
  <h2 class="home-section__title">Full Publication Record</h2>
  <p class="home-section__intro">
    My most up-to-date publication list is maintained on Google Scholar.
    You can browse papers, citations, and co-authorship details there.
  </p>
  {% if site.author.googlescholar %}
    <p>
      <a class="btn btn--primary home-cta home-cta--primary" href="{{ site.author.googlescholar }}" target="_blank" rel="noopener noreferrer">Open Google Scholar</a>
    </p>
  {% endif %}
</section>

{% include home/featured-papers.html
  title="Featured Papers and Research Threads"
  intro="A short set of highlighted topics and links."
%}

<section class="home-section">
  <h2 class="home-section__title">Archive</h2>
  <p class="home-section__intro">
    Legacy publication entries in this site repository are kept below.
  </p>

  {% include base_path %}
  {% for post in site.publications reversed %}
    {% include archive-single.html %}
  {% endfor %}
</section>
