import { URL } from 'url'

export async function runEveryMinute(meta) {
    const activeIncidentKey = await meta.cache.get("pagerduty_active_incident")
    const isInError = await isTrendErroring(meta)

    // console.log({ activeIncidentKey, isInError })

    if (activeIncidentKey && !isInError) {
        await resolvePagerduty(activeIncidentKey, meta)
        console.log('Resolved pagerduty incident', activeIncidentKey)
    } else if (!activeIncidentKey && isInError) {
        const key = await triggerPagerduty(meta)
        console.log('Triggered pagerduty incident', key)
    } else if (isInError) {
        console.log('Pagerduty incident is active, ignoring error for now')
    } else {
        console.log('All good! 😍')
    }
}

async function isTrendErroring(meta) {
    const insight = await getTrend(meta)

    if(insight.filters.insight !== "TRENDS") {
        throw "The provided insight is not a trend"
    }

    const result = insight.result?.[0]

    if(!result) {
        console.warn("Insight returned no result")
        return
    } else if(result.data.length === 0) {
        console.warn("Insight returned no data")
        return
    }

    // Only consider the two most recent data points
    const latestDataPoints = result.data.slice(-2);

    return latestDataPoints.every((value) =>
        dataPointInError(value, parseFloat(meta.config.threshold), meta.config.operator)
    )
}

function dataPointInError(value, threshold, operator) {
    if (operator.startsWith('≤')) {
        return value <= threshold
    } else {
        return value >= threshold
    }
}

async function getTrend(meta) {
    const insightId = insightIdFromUrl(meta.config.posthogTrendUrl)

    const apiUrl = new URL(
        `/api/projects/${meta.config.posthogProjectId}/insights?short_id=${insightId}`,
        meta.config.posthogTrendUrl
    )

    const response = await fetch(apiUrl, {
        headers: {
            authorization: `Bearer ${meta.config.posthogApiKey}`
        }
    })

    if (!response.ok) {
        throw Error(`Error from PostHog API: status=${response.status} response=${await response.text()}`)
    }

    const { results } = await response.json()

    // console.log('Got PostHog trends results', results)
    return results[0]
}

async function triggerPagerduty(meta) {
    const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'post',
        headers: {
            'Content-Type': 'application/json',
            'accept': 'application/vnd.pagerduty+json;version=2',
        },
        body: JSON.stringify({
            "routing_key": meta.config.pagerdutyIntegrationKey,
            "event_action": "trigger",
            "payload": {
                "summary": `${meta.config.pagerdutyIncidentSummary} - query returned 0`,
                "source": meta.config.posthogHost,
                "severity": "critical",
            },
            "links": [
                {
                    "href": meta.config.posthogTrendUrl,
                    "text": "Posthog Trends API query url"
                }
            ],
            "custom_details": {
                "operator": meta.config.operator,
                "threshold": meta.config.threshold
            }
        })
    })

    if (!response.ok) {
        throw Error(`Error from PagerDuty API: status=${response.status} response=${await response.text()}`)
    }

    // console.log('Got PagerDuty response', { status: response.status, text: await response.clone().text() })

    const { dedup_key } = await response.json()
    await meta.cache.set("pagerduty_active_incident", dedup_key)

    return dedup_key
}

async function resolvePagerduty(incidentKey, meta) {
    // TODO: Should check whether this response was successful
    await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'post',
        headers: {
            'Content-Type': 'application/json',
            'accept': 'application/vnd.pagerduty+json;version=2',
        },
        body: JSON.stringify({
            "routing_key": meta.config.pagerdutyIntegrationKey,
            "event_action": "resolve",
            "dedup_key": incidentKey,
        })
    })

    await meta.cache.set("pagerduty_active_incident", null)
}

function insightIdFromUrl(trendsUrl) {
    const url = new URL(trendsUrl)

    if (url.pathname.startsWith('/insights')) {
        const [_, insightId] = /\/insights\/([a-zA-Z0-9]*)$/.exec(url.pathname)

        if(!insightId) {
            throw Error(`Not a valid trends URL: ${trendsUrl}`)
        }

        return insightId
    }

    throw Error(`Not a valid trends URL: ${trendsUrl}`)
}
