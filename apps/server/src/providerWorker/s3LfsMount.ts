export const S3_LFS_MOUNT_ROOT = "/root/.synara-s3-lfs";
export const S3_LFS_PASSWORD_PATH = "/root/.synara-s3-lfs.passwd";
export const S3_LFS_AGENT_UID = 10001;

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function s3LfsMountConfig(environment: NodeJS.ProcessEnv) {
  if (environment.SYNARA_PROVIDER_WORKER_S3_LFS !== "true") return undefined;
  const bucket = environment.SYNARA_GITEA_LFS_S3_BUCKET?.trim();
  const prefix = environment.SYNARA_GITEA_LFS_S3_PREFIX?.trim();
  const endpoint = environment.SYNARA_GITEA_LFS_S3_ENDPOINT?.trim();
  const region = environment.SYNARA_GITEA_LFS_S3_REGION?.trim();
  const accessKey = environment.SYNARA_GITEA_LFS_S3_ACCESS_KEY_ID?.trim();
  const secretKey = environment.SYNARA_GITEA_LFS_S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !/^[a-z0-9][a-z0-9.-]+$/u.test(bucket) ||
      !prefix || !/^[a-z0-9][a-z0-9/-]*\/$/u.test(prefix) ||
      !endpoint || new URL(endpoint).protocol !== "https:" ||
      !region || !/^[a-z0-9-]+$/u.test(region) || !accessKey || !secretKey ||
      /[\r\n:]/u.test(accessKey) || /[\r\n]/u.test(secretKey)) {
    throw new Error("S3 LFS mount requires valid bucket, prefix, HTTPS endpoint, region, and credentials.");
  }
  return { bucket, prefix, endpoint, region, accessKey, secretKey };
}

export function s3LfsMountCommand(config: NonNullable<ReturnType<typeof s3LfsMountConfig>>) {
  return [
    "set -eu",
    `mkdir -p -m 700 ${quote(S3_LFS_MOUNT_ROOT)}`,
    `if ! mountpoint -q ${quote(S3_LFS_MOUNT_ROOT)}; then s3fs ${quote(`${config.bucket}:/${config.prefix.replace(/\/$/u, "")}`)} ${quote(S3_LFS_MOUNT_ROOT)} -o passwd_file=${quote(S3_LFS_PASSWORD_PATH)} -o url=${quote(config.endpoint)} -o use_path_request_style -o endpoint=${quote(config.region)} -o compat_dir -o ro -o allow_other -o uid=${S3_LFS_AGENT_UID} -o gid=${S3_LFS_AGENT_UID}; fi`,
    `mountpoint -q ${quote(S3_LFS_MOUNT_ROOT)}`,
  ].join("; ");
}
