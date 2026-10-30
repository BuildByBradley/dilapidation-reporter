**Subject:** Dilapidation Inspector: request to approve a controlled pilot (briefing attached)

Hi team,

Thank you for the feedback on two-factor authentication. I've included a plan for it in the attached briefing.

I'd like your approval to run the **Dilapidation Inspector** in a controlled pilot. It's a web app for recording building-condition inspections on site, on phones and tablets, with the results shared with the office.

**Where it is today**
- I have used it on one complete live project: 9 floors, 247 findings and 513 photos over about three days.
- It produced a client report that I edited to suit the project.
- Several people captured on the same project at the same time, and work captured on a phone appeared on the computer after sign-in.
- Colleagues were given view access by invite link.

**What I want to be upfront about**
- It was built with an AI coding assistant (Claude Code), directed by me. It has not had an independent code review or a penetration test.
- It currently runs on my personal GitHub and Supabase accounts. The project's data, including real client data, is held there.
- Sign-up is open to anyone with the link, and there is no two-factor authentication yet.
- It has not been tested on every device and browser we use.

**What I'm asking for**
Approval for a **pilot with named users only**, while we close the gaps for company-wide use. The briefing lists 14 gaps with a proposed fix for each. Section 10 lists the decisions I need from you, including:
- approved hosting and backend, and who administers it
- authenticator-app two-factor now, or company single sign-on later
- whether the AI help box (which uses a third-party API) is allowed
- the controls you need before wider release

**Attached / linked**
- `IT-BRIEFING.md`: the full breakdown (how it was built, architecture, data and access control, test results, gaps, decisions)
- Code and change history: https://github.com/BuildByBradley/dilapidation-reporter/pull/2
- The live app: https://buildbybradley.github.io/dilapidation-reporter/

I'm happy to walk you through it, or give you a login to test.

Regards,
Bradley
