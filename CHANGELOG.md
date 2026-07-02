# Changelog

Release notes for Carbon. The release pipeline extracts the section whose heading
starts with the pushed tag (e.g. `## v0.6.0`) and uses it verbatim as both the
GitHub Release body and the public mirror commit message — so keep each heading's
first token equal to the tag. See [docs/RELEASING.md](docs/RELEASING.md).

## v0.5.5
**UI Polishing**  
- Made CalDAV Settings less technically worded

**Performance**  
Heaps more clean up and optimisation.  
What matters is the results..  

|Operation|Original|Now|
|---|---|---|
|interaction:add|1009 ms|193 ms (5.2×)|
|interaction:complete|574 ms|139 ms (4.1×)|
|interaction:switch|439 ms|243 ms (1.8×)|
|query:forecast.data|261 ms|96 ms (2.7×)|
|query:container.data|26 ms|2.9 ms (9×)|
|scroll frames >50ms jank|~13|5|

**More Thorough Testing**
- Better and more complete performance tests
- True 2 server, and 2 browser testing using playwright for end to end tests


## v0.5.4
**UI Polishing**
- Show task count on Plan
- Don't show decimal minutes in side panel for time tracked
- Sync Interval for CalDAV and ical are now in Minutes, not Seconds
- Collapse Calendar Sync by default in Right Panel

**Performance**
- Added prepared statement cache, about 5x improvement to performance
- Sidebar calculations in background, no interaction delay when computing task counts

**iCal and CalDAV Changes**
- Never allow pulling past events
- Protect against potential push-pull-> loop with sync
- Timezone Corrections

## v0.5.3
**Calendar Sync Enhancements**
- Support iCal
- Support Repeating Events in CalDAV
- Only fetch current and future calendar events

## v0.5.2
**Time Tracker Enhancements**
- Track Start and End time of each task within a time block
- Record Task Completion time
- Track Pause Start and End times
- Report Wall Time, Task Time and Project Time as individual stats
- Report all above, as well as tags on each task, in exported CSV

## v0.5.1

- Automated multi-platform release pipeline: tagging in the private dev repo now
  mirrors a squashed snapshot to the public repo, which builds and publishes
  desktop (Linux + Windows) and Android artifacts to a GitHub Release.
- Desktop auto-update via the Tauri updater (silent download, confirmed install).
- Android sideload builds link out to the newest GitHub-released APK.
- About page now shows App version and Server version separately.

## v0.5.0 - Carbon Perspective

- Perspective views and related improvements.
