export interface ModelVersion {
  name: string;
  version: string;
}

export const BASELINE_MODEL: ModelVersion = {
  name: "drift-zscore",
  version: "2.0.0",
};
