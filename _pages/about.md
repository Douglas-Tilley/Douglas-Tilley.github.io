---
permalink: /
title: "Doug Tilley"
layout: splash
author_profile: false
classes: wide
redirect_from:
  - /about/
  - /about.html
---

{% include home/hero.html %}

{% include home/current-work.html
  title="Currently Building"
  intro="From neuromorphic architectures to field-deployed wildlife sensors — here's what's on the bench."
%}

{% include home/repo-grid.html
  section_id="home-repos"
  title="Code & Projects"
  intro="Active repositories spanning optimizers, spiking networks, embedded vision, and more. Some are pre-publication or in the works."
  max_items=4
%}

{% include home/featured-papers.html
  title="Selected Publications"
  intro="Highlights from my publication record. Full list and citation metrics on Google Scholar."
%}

{% include home/interests.html
  title="Research Interests"
  intro="The threads that connect my work; from biologically plausible learning to robots that understand people."
%}
