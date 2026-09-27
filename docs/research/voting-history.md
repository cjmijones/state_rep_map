# Legislative roll-call voting history

Research checked September 26, 2026. “Voting history” here means recorded individual roll-call votes, not every decision made by a chamber.

## State legislatures

[Open States API v3](https://docs.openstates.org/api-v3/) covers state legislative information, including bills with related votes. The API root is `https://v3.openstates.org/`; it requires an API key in the `X-API-KEY` header or `apikey` query parameter. The bill detail model can contain multiple votes, but results are paginated. A vote event has a jurisdiction vote identifier, date, motion, result, chamber/organization, aggregate counts and source URLs; individual member votes can be absent depending on the jurisdiction. This is an aggregator built by scraping state legislative sites, so state-by-state completeness and individual-level coverage need to be checked before presenting an empty result as “did not vote.” See [Open States vote data schema](https://docs.openstates.org/api-v2/types/) and [data model notes](https://docs.openstates.org/data/).

For a refreshable import, Open States offers per-session bill-and-vote [CSV archives](https://open.pluralpolicy.com/data/session-csv/) and [JSON archives](https://open.pluralpolicy.com/data/session-json/). The provider says these are sourced from legislative-site scrapers and update monthly. Its public PostgreSQL dump is closer to current (typically no more than a day or two behind online data), but the internal schema has no stability guarantee. The API is the simpler on-demand path; bulk JSON/CSV is the more practical refresh pipeline if the app will cache and normalize votes. Preserve Open States IDs, source URLs, and update timestamps, and refresh by legislative session. No authoritative uniform guarantee of vote coverage or API quota was stated in the docs reviewed.

## Federal House and Senate

The strongest no-key probe is the Senate’s official XML feed. Senate.gov publishes links to XML for both [roll-call vote lists and individual votes](https://www.senate.gov/general/XML.htm); the list links to each vote. The current-session list follows the form `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml`; a current sample individual vote is `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.xml`. Both returned XML content-type responses when opened without credentials in this research. The individual XML reports the question, issue, date/time, result, tally, and each senator’s vote. Senate.gov documents archives back to the 101st Congress. Use vote number plus Congress/session as the stable key; crawl the session list and upsert details. The Senate says roll-call tallies are generally posted within an hour. See its [coverage and definitions](https://www.senate.gov/legislative/HowTo/how_to_votes.htm).

The House Clerk has official vote pages with an “XML View” link and member-level vote, party, state, vote question, type, result, and totals—for example [Roll Call 1 in 2026](https://clerk.house.gov/Votes/20261). A direct legacy XML URL worth probing is `https://clerk.house.gov/evs/2026/roll001.xml`; it was fetched as XML without an API key during this research. The House Clerk says results are posted directly following the vote, and its official archive runs from the 101st Congress, second session. See [House and Senate vote coverage](https://www.senate.gov/legislative/HowTo/how_to_votes.htm). House roll-call number is session/year-specific; key records by Congress, session, and roll number.

Congress.gov API v3 is a potential structured alternative, but requires a free API key; its documented general limit is 5,000 requests/hour, with pagination capped at 250 items. Its new House vote endpoints (`/house-vote/{congress}/{session}`, detail, and `/members`) are beta and currently cover House roll calls associated with legislation in the 118th and 119th Congresses; non-legislation votes such as Speaker elections are excluded for now. See [official API overview and limits](https://github.com/LibraryOfCongress/api.congress.gov) and [House vote coverage/schema](https://github.com/LibraryOfCongress/api.congress.gov/blob/main/Documentation/HouseRollCallVoteEndpoint.md). The API has no Senate vote endpoint documented; use Senate.gov XML for that chamber. Congress.gov bill actions can also link to official House/Senate vote pages, but are not a substitute for a complete vote feed.

## Scope and caveat

Roll-call data does not contain every floor vote: voice votes, unanimous consent, and some division votes do not record each member by name. The Senate explicitly distinguishes these from roll calls and identifies the Congressional Record as the official source for recorded floor votes. Accordingly, label the feature “recorded roll-call votes” and treat “not voting” as different from no vote record.

## Suggested first probes

1. No key: fetch the Senate session list XML above, follow one listed vote to its XML, and verify individual vote rows.
2. No key: fetch the House Clerk XML View for [20261](https://clerk.house.gov/Votes/20261), verify the XML media type and member vote fields; try the legacy `roll001.xml` URL if the embedded link cannot be followed.
3. With a key: query Open States for one known state bill with votes and inspect whether its vote event includes individual votes and sources.
4. With a Congress.gov key: query `/v3/house-vote/119/2`, then follow a result’s detail URL and members endpoint; treat coverage as beta and legislation-associated only.
