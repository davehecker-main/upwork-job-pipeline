/**
 * Upwork GraphQL requests, and the adapter from a GraphQL job node to the raw
 * shape src/normalize-upwork.js consumes.
 *
 * ⚠️ UNVERIFIED FIELD NAMES. The search RESPONSE shape this pipeline was built
 * against was captured from Upwork's official MCP server, which is verified end
 * to end (see tests/fixtures/upwork-search.json). The GraphQL selection sets
 * below are composed from the documented type names for `marketplaceJobPostings`
 * -- api.upwork.com is not reachable without a token, so they have NOT been run.
 *
 * Before WF1 goes live, run scripts/verify-upwork-graphql.mjs with a token: it
 * executes both queries and reports exactly which fields the API rejects. Fix
 * them HERE - every other layer consumes the adapter's output, not the raw
 * response, so nothing else changes.
 *
 * Endpoint: POST https://api.upwork.com/graphql
 * Headers:  Authorization: Bearer <token>
 *           X-Upwork-API-TenantId: <org_uid>
 */

export const GRAPHQL_URL = 'https://api.upwork.com/graphql';

/** Marketplace search. Ordered by recency; there is no created_after filter. */
export const SEARCH_QUERY = `
query MarketplaceJobs($request: MarketplaceJobPostingsSearchRequest!) {
  marketplaceJobPostings(marketPlaceJobFilter: $request) {
    totalCount
    edges {
      node {
        id
        ciphertext
        title
        description
        skills { name }
        job { contractTerms { contractType fixedPriceContractTerms { amount { rawValue } } hourlyContractTerms { engagementDuration { label } hourlyBudgetType hourlyBudgetMin hourlyBudgetMax } } }
        upworkHistoryData { client { totalPostedJobs totalHires totalSpent { rawValue } totalFeedback totalReviews location { country } paymentVerificationStatus } }
        activityStat { applicationsBidStats { avgRateBid { rawValue } } totalApplicants }
        experienceLevel
        publishedDateTime
        createdDateTime
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`.trim();

/** One posting in full - used only on jobs that survived scoring. */
export const JOB_DETAIL_QUERY = `
query MarketplaceJob($id: ID!) {
  marketplaceJobPosting(id: $id) {
    id
    ciphertext
    title
    description
    skills { name }
    preferredQualifications { minJobSuccessScore risingTalent earnings }
    activityStat { totalApplicants }
  }
}`.trim();

/**
 * Build the search request body for one configured query.
 * @param {{query: string}} search one SEARCH_QUERIES entry
 * @param {object} filters SEARCH_FILTERS
 */
export function buildSearchRequest(search, filters = {}) {
  const request = {
    searchExpression_eq: search.query,
    sortAttributes: [{ field: 'RECENCY' }],
    paging: { offset: 0, count: filters.limit || 10 },
  };
  if (filters.verified_payment_only) request.paymentVerified_eq = true;
  if (filters.proposals_max != null) request.proposalRange = { rangeEnd: filters.proposals_max };

  return { query: SEARCH_QUERY, variables: { request } };
}

export function buildJobDetailRequest(jobId) {
  return { query: JOB_DETAIL_QUERY, variables: { id: String(jobId) } };
}

/**
 * GraphQL node -> the flat shape normalizeUpworkJob() already handles, so both
 * transports converge on one normalizer and one set of tests.
 */
export function fromGraphQL(node) {
  const n = node && typeof node === 'object' ? node : {};
  const terms = n.job?.contractTerms || {};
  const hourly = terms.hourlyContractTerms || {};
  const fixed = terms.fixedPriceContractTerms || {};
  const client = n.upworkHistoryData?.client || {};
  const cipher = n.ciphertext ? String(n.ciphertext).replace(/^~/, '') : null;

  return {
    id: n.id || cipher,
    title: n.title,
    description: n.description,
    skills: Array.isArray(n.skills) ? n.skills.map((s) => s && s.name).filter(Boolean) : undefined,
    job_type: String(terms.contractType || '').toLowerCase() === 'hourly' ? 'hourly' : 'fixed',
    budget: fixed.amount?.rawValue,
    hourly_budget_type: hourly.hourlyBudgetType
      ? String(hourly.hourlyBudgetType).toLowerCase().replace(/_/g, ' ')
      : undefined,
    budget_hourly_min: hourly.hourlyBudgetMin,
    budget_hourly_max: hourly.hourlyBudgetMax,
    duration: hourly.engagementDuration?.label,
    experience_level: n.experienceLevel,
    proposal_count: n.activityStat?.totalApplicants,
    created_date: n.createdDateTime,
    published_date: n.publishedDateTime || n.createdDateTime,
    url: cipher ? `https://www.upwork.com/jobs/~${cipher}` : undefined,
    client: {
      verification_status: client.paymentVerificationStatus,
      total_spent: client.totalSpent?.rawValue,
      total_hires: client.totalHires,
      total_posted_jobs: client.totalPostedJobs,
      rating: client.totalFeedback,
      total_reviews: client.totalReviews,
      country: client.location?.country,
    },
  };
}

/** Pull the job nodes out of a search response, tolerating either envelope. */
export function jobsFromSearchResponse(response) {
  const edges = response?.data?.marketplaceJobPostings?.edges;
  if (Array.isArray(edges)) return edges.map((e) => fromGraphQL(e && e.node)).filter(Boolean);
  // The MCP transport returns the already-flat shape.
  if (Array.isArray(response?.jobs)) return response.jobs;
  return [];
}
