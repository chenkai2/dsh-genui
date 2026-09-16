/**
 * Localized labels required by the DSH UI primitives.
 *
 * The primitives take their chrome as plain label objects, so these are built
 * PER RENDER from the active locale (`labelsOf*()`) rather than frozen at
 * module load — a language switch must reach a diff or JSON tree that is
 * already on screen.
 */
import type { DiffBlockLabels, JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './i18n/index.ts'

/** Chrome labels for an inline GenUI diff block, in the active locale. */
export function diffBlockLabels(): DiffBlockLabels {
  return {
    copy: t('label.copy'),
    copied: t('label.copied'),
    collapseAria: t('label.collapseDiff.aria'),
    /** Accessible label for expanding a collapsed diff tail. */
    expandAria(hidden) { return t('label.expandDiff.aria', { hidden }) },
    collapse: t('label.collapse'),
    /** Visible label for expanding a collapsed diff tail. */
    expand(hidden) { return t('label.expandDiff', { hidden }) },
    /** Localized file-count summary in the diff footer. */
    files(count) { return t('label.diffFiles', { count }) },
  }
}

/** Copy labels for a code block rendered inside a GenUI fence or node. */
export function codeBlockLabels(): { copyLabel: string, copiedLabel: string } {
  return {
    copyLabel: t('label.copy'),
    copiedLabel: t('label.copied'),
  }
}

/** Chrome labels for an inline GenUI JSON tree, in the active locale. */
export function jsonTreeLabels(): JsonTreeLabels {
  return {
    copyValue: t('label.copyValue'),
    copyJson: t('label.copyJson'),
    copyPath: t('label.copyPath'),
    copyPrettyJson: t('label.copyPrettyJson'),
    copyCompactJson: t('label.copyCompactJson'),
    copied: t('label.copiedDone'),
    copyFailed: t('label.copyFailed'),
    collapseNode: t('label.collapseNode'),
    expandNode: t('label.expandNode'),
    /** Tooltip for a JSON tree copy action. */
    copyButtonTitle(action) { return t('label.copyButtonTitle', { action }) },
  }
}
