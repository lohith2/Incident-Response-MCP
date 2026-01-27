import { useEffect, useRef, useState } from "react";
import {
    fetchRagHitRate,
    fetchKnowledgeBaseGrowth,
    fetchRecurringIssues,
    type RagHitRate,
    type KnowledgeBaseGrowthPoint,
    type RecurringIssue,
} from "../api/client";

export function useRagMetrics(pollIntervalMs = 10_000) {
    const [ragHitRate, setRagHitRate] = useState<RagHitRate | null>(null);
    const [knowledgeBaseGrowth, setKnowledgeBaseGrowth] = useState<KnowledgeBaseGrowthPoint[]>([]);
    const [recurringIssues, setRecurringIssues] = useState<RecurringIssue[]>([]);
    const [loading, setLoading] = useState(true);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    async function load() {
        const [hr, kb, ri] = await Promise.all([
            fetchRagHitRate(),
            fetchKnowledgeBaseGrowth(),
            fetchRecurringIssues(),
        ]);
        setRagHitRate(hr);
        setKnowledgeBaseGrowth(kb);
        setRecurringIssues(ri);
        setLoading(false);
    }

    useEffect(() => {
        void load();
        timerRef.current = setInterval(() => void load(), pollIntervalMs);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [pollIntervalMs]);

    return { ragHitRate, knowledgeBaseGrowth, recurringIssues, loading };
}
