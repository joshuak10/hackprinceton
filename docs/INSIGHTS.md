# Post-simulation feedback

Run `npm run web` and open `http://localhost:4174/scope/`. Restart an older static preview server to enable the API. The viewer requests feedback when a completed recording loads; replay playback does not need to reach the end. Select **Suggestions** in the toolbar or **View feedback & suggestions** in the sidebar to read the report. Both the preview server and the full API server expose the analysis endpoint.

The backend collects aggregate outcomes, recorded choices, location waits/delays, group-level waiting and abandonment, and reported experiences. Decision logs are streamed and aggregated. It sends only compact evidence to Claude, not raw persona biographies or frame positions. Findings include evidence references, a suggested experiment, and an evaluation plan. Suggestions are hypotheses, not measured improvements.

Set `ANTHROPIC_API_KEY` in `.env.local` for Claude analysis. `ANALYSIS_MODEL` optionally overrides the model (default matches compilation: `claude-opus-5-5`). Without a key, or if the provider fails or returns invalid evidence references, the agent returns clearly labeled recorded-data findings. The provider has a 45-second timeout and no automatic retries.

`POST /api/insights` accepts `{ "caseId": "building" }`, `{ "caseId": "parking" }`, or `{ "runId": "<completed-run-id>" }`, plus an optional `question` (up to 2,000 characters). The server reads its own recordings; clients cannot submit arbitrary paths or invented metrics. Failed/incomplete runs are rejected. Concurrent identical requests share a result, analysis concurrency is capped at two, and a bounded cache retains recent reports. Completed-run reports are saved in `runs/<id>/insights.json` with a hash of the analysis inputs.

The frontend shows status, a summary, a detailed feedback dialog, all collected evidence, limitations, and a retry action for request failures. Switching recordings cancels the old browser request and prevents stale feedback from replacing the new report.

Verification: `node --test "test/*.test.js"`. The insight tests cover evidence semantics, no-key/provider-failure fallbacks, structured AI responses, invalid citations, caching, persistence, input validation, and the HTTP endpoint. Real provider calls are not part of the test suite.
