// Control UI component implements the dashboard header element.
import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../../i18n/index.js";
import { pathForTab, titleForTab, type Tab } from "../navigation.js";

export class DashboardHeader extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() tab: Tab = "overview";
  @property() basePath = "";
  @property() agentLabel = "";
  @property() sessionLabel = "";
  @property({ attribute: false }) contextChips: string[] = [];

  private readonly handleOverviewClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: "overview", bubbles: true, composed: true }),
    );
  };

  override render() {
    const label = titleForTab(this.tab);
    const agentLabel = this.agentLabel.trim();
    const sessionLabel = this.sessionLabel.trim();
    const chips = this.contextChips.filter((entry) => entry.trim());

    return html`
      <div class="dashboard-header">
        <div class="dashboard-header__breadcrumb">
          <a
            class="dashboard-header__breadcrumb-link"
            href=${pathForTab("overview", this.basePath)}
            @click=${this.handleOverviewClick}
          >
            OpenClaw
          </a>
          ${agentLabel
            ? html`
                <span class="dashboard-header__breadcrumb-segment">
                  <span class="dashboard-header__breadcrumb-sep">›</span>
                  <span class="dashboard-header__breadcrumb-context" title=${agentLabel}>
                    ${agentLabel}
                  </span>
                </span>
              `
            : nothing}
          ${sessionLabel
            ? html`
                <span class="dashboard-header__breadcrumb-segment">
                  <span class="dashboard-header__breadcrumb-sep">›</span>
                  <span class="dashboard-header__breadcrumb-context" title=${sessionLabel}>
                    ${sessionLabel}
                  </span>
                </span>
              `
            : nothing}
          <span class="dashboard-header__breadcrumb-sep">›</span>
          <span class="dashboard-header__breadcrumb-current">${label}</span>
        </div>
        ${chips.length
          ? html`
              <div class="dashboard-header__chips" aria-label=${t("chat.selectors.sessionContext")}>
                ${chips.map((chip) => html`<span class="dashboard-header__chip">${chip}</span>`)}
              </div>
            `
          : nothing}
        <div class="dashboard-header__actions">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("dashboard-header")) {
  customElements.define("dashboard-header", DashboardHeader);
}
