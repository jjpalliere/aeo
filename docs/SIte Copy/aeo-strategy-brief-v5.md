# AEO Strategy Brief — v5

---

## Opening

**Headline:**
92% of searches that show an AI summary never result in a website click.

**Subhead:**
LLMs are being asked questions about your brand every day. AEO is how you understand what they're saying — and influence it.

**Body:**
AEO stands for Answer Engine Optimization. It's a set of analyses that show how AI assistants like ChatGPT, Claude, and Gemini are representing a brand when buyers ask them questions, and what to do to improve that representation.

Here's how each analysis works.

---

## Section 1: Measuring LLM Visibility

**Heading:**
Measuring LLM visibility starts with querying at scale.

**Body:**
There's no platform that shows how an LLM is representing a brand. There's no dashboard inside ChatGPT showing how often a brand gets mentioned, in what context, or alongside which competitors. LLM responses also vary — the same question asked twice returns a different answer — so manual spot-checking doesn't produce a reliable picture.

The tool queries programmatically. It submits a set of prompts to each LLM via API and analyzes the responses across hundreds of calls: which brands get mentioned, in what rank order, which URLs get cited. At that volume, consistent patterns emerge. Which LLMs favor which competitors, which topics a brand appears in, which it doesn't.

Persona scoring, channel analysis, and format recommendations all start from this data.

---

## Section 2: Persona Scoring

**Heading:**
Performance is scored per persona, not just in aggregate.

**Body:**
A CFO evaluating a purchase is asking completely different questions than the team member who'd actually use the product day-to-day. Each is having separate interactions with LLMs, with different prompts, different competitors surfacing, and different sources being cited.

Every prompt in the system is mapped to a specific persona. Performance gets scored at the prompt level, then rolled up into a persona-level view. The output shows how a brand is performing for each buyer type: where it's well-represented, and where it's absent.

If a brand is underperforming for a particular persona, the prompt-level data shows which questions are going unanswered and which competitors are answering them.

---

## Section 3: Channel Analysis

**Heading:**
LLMs cite a brand's website, but they give more weight to third-party sources.

**Body:**
When an LLM responds to a query, it cites URLs. A mention in a well-read industry outlet, a review on a comparison platform, a quote in a relevant news piece — these tend to carry more influence than a brand's own pages saying the same things.

The channel analysis collects every URL the LLMs cite across the tracked prompts and classifies each one: owned pages, competitor pages, news outlets, industry sites, review platforms.

A few things come out of this. Outlets that consistently appear in a category but haven't covered a particular brand are PR and partnership targets. Third-party content that's outdated or inaccurate but still getting surfaced can be found and corrected. Which source types dominate in a given industry shows where buyers in that space go to research, which informs channel strategy beyond AEO. And sources that surface for competitors but not for a given brand show where its distribution is thin, separate from whether its content is good.

---

## Section 4: Format Analysis

**Heading:**
How content is structured affects whether LLMs can use it.

**Body:**
When an LLM's web search tool lands on a page, it's scanning rather than reading carefully. It's looking for content that directly matches the user's query and can be used in a response as-is. A page titled "Our Approach to Customer Onboarding" requires the LLM to infer relevance. A page titled "How long does customer onboarding typically take?" answers the query directly.

A few structural patterns make content easier for LLMs to use. Headers written as questions create direct matches to user queries. FAQ sections that restate a question and answer it in clear bullets mirror the format LLMs use in their own responses. Comparative and superlative language gets picked up in evaluation-stage queries because that's how buyers phrase questions when they're assessing options.

There's also a technical layer. Schema markup, linked data, and updated metadata give the LLM's web helper an immediate read on what a page is about, who wrote it, and when. Without those signals the AI has to infer. With them, the page is legible immediately.

---

## Section 5: Gap Analysis

**Heading:**
The right prompts to track come from mapping what a brand covers, what competitors cover, and what buyers actually need to know.

**Body:**
Before any queries get run, there's a foundational question: which prompts are worth tracking? The answer matters because the prompts define everything measured downstream.

One approach is to generate prompts from a brand's own website. The limitation is that a website reflects what a brand has already decided to talk about, so the prompts it suggests will be ones the brand is already well-positioned for.

Buyers in most categories go to LLMs to find out who the main players are, how pricing typically works, and how different approaches compare. Most brand websites don't address those questions directly. That's where the gap tends to be.

The gap analysis maps three things against each other: the topics a brand covers, the topics its competitors cover, and the questions its target buyers are realistically asking. Where those three don't overlap is where the content strategy has room to go, either to compete on topics competitors already own, or to address territory nobody has covered yet.

This is also the right starting point before a new product launch. Existing LLM performance data isn't needed. It's a messaging exercise, and the output is a set of prompts worth tracking.

---

## Closing

**Heading:**
This is what the tool runs.

**Body:**
Every audit starts with the gap analysis, building the right prompt set before running anything. From there, the tool queries at scale, scores results by persona, maps the citation footprint, and identifies format improvements from what the data shows.

**CTA:** Start an audit →
