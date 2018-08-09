import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";

const tenMinutes = 60 * 10;

// crawlDirectory recursive crawls the provided directory, applying the provided function
// to every file it contains. Doesn't handle cycles from symlinks.
function crawlDirectory(dir: string, f: (_: string) => void) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = `${dir}/${file}`;
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            crawlDirectory(filePath, f);
        }
        if (stat.isFile()) {
            f(filePath);
        }
    }
}

// Split a domain name into its subdomain and parent domain names.
// e.g. "www.example.com" => "www", "example.com".
function getDomainAndSubdomain(domain: string): { subdomain: string, parentDomain: string } {
    const parts = domain.split(".");
    if (parts.length < 2) {
        throw new Error(`No TLD found on ${domain}`);
    }
    // No subdomain, e.g. awesome-website.com.
    if (parts.length === 2) {
        return { subdomain: "", parentDomain: domain };
    }

    const subdomain = parts[0];
    parts.shift();  // Drop first element.
    return {
        subdomain,
        // Trailing "." to canonicalize domain.
        parentDomain: parts.join(".") + ".",
    };
}

// Creates a new Route53 DNS record pointing the domain to the CloudFront distribution.
function createAliasRecord(
        targetDomain: string,
        distribution: aws.cloudfront.Distribution,
        opts: pulumi.ResourceOptions): aws.route53.Record {
    const domainParts = getDomainAndSubdomain(targetDomain);
    const hostedZoneId = aws.route53.getZone({ name: domainParts.parentDomain }).then(zone => zone.zoneId);
    return new aws.route53.Record(
        targetDomain,
        {
            name: domainParts.subdomain,
            zoneId: hostedZoneId,
            type: "A",
            aliases: [
                {
                    name: distribution.domainName,
                    zoneId: distribution.hostedZoneId,
                    evaluateTargetHealth: true,
                },
            ],
        },
        opts);
}

/**
 * Arguments to StaticWebsite concerning the website's contents.
 */
export interface ContentArgs {
    /**
     * Path to the content files to serve relative to the CWD of the Pulumi program.
     */
    pathToContent: string;

    /**
     * Path to the resource to serve if the CDN fails to locate the intended
     * resource.
     */
    custom404Path?: string;
}

/**
 * Arguments to StaticWebsite optionally specifying how a domain should be attached.
 */
export interface DomainArgs {
    // targetDomain is Route53 hosted domain to create the domain on. If it is
    // a subdomain, ("www.example.com"), the A record "www" will be created. If
    //  it is the root domain ("example.com"), the A record "" will be created
    // instead.
    targetDomain: string;

    // acmCertificateArn is the ARN to an ACM certificate, matching the target
    // domain. Must be in the us-east-1 region; this is a requirement imposed
    // by CloudFront.
    acmCertificateArn: string;
}


/**
 * Static website using Amazon S3, CloudFront, and Route53.
 */
export class StaticWebsite extends pulumi.ComponentResource {
    // contentBucket is the S3 bucket that the website's contents will be
    // stored in. Note that the contents of the S3 bucket will be publicly
    // visible, just like the resulting website.
    readonly contentBucket: aws.s3.Bucket;

    // logsBucket is an S3 bucket that will contain the CDN's request logs.
    // Will be private, and can later be queried using AWS Athena.
    readonly logsBucket: aws.s3.Bucket;

    // cdn is the actual CloudFront distribution which speeds up delivery
    // by caching content in edge nodes across the world.
    readonly cdn: aws.cloudfront.Distribution;

    // aRecord is the ALIAS record created on the target domain which
    // points to the CDN. If DomainArgs is not specified, will be null.
    readonly aRecord?: aws.route53.Record;

    /**
     * Creates a new static website hosted on AWS.
     * @param name The _unique_ name of the resource.
     * @param contentArgs The arguments to configure the content being served.
     * @param domainArgs The arguments to configure the domain and DNS settings.
     * @param opts A bag of options that control this resource's behavior.
     */
     constructor(name: string, contentArgs: ContentArgs, domainArgs?: DomainArgs, opts?: pulumi.ResourceOptions) {
        const inputs: pulumi.Inputs = {
            options: opts,
        };
        super("pulumi-contrib:components:StaticWebsite", name, inputs, opts);

        // Default resource options for this component's child resources.
        const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

        // Create/populate the S3 bucket storing the website's content.
        this.contentBucket = new aws.s3.Bucket(
            `${name}-content`,
            {
                acl: "public-read",
                // Configure S3 to serve bucket contents as a website. This way
                // S3 will automatically convert requests for "foo/" to
                // "foo/index.html".
                website: {
                    indexDocument: "index.html",
                    errorDocument: "404.html",
                },
            }, defaultResourceOptions);

        // Sync the contents of the source directory with the S3 bucket, which
        // will in-turn be served by S3, and then cached via CloudFront.
        const webContentsRootPath = path.join(process.cwd(), contentArgs.pathToContent);
        if (!fs.existsSync(webContentsRootPath)) {
            throw `Error: website contents path '${webContentsRootPath} does not exist.`;
        }
        if (!fs.statSync(webContentsRootPath).isDirectory()) {
            throw `Error: website contents path '${webContentsRootPath} is not a directory.`;
        }
        crawlDirectory(
            webContentsRootPath,
            (filePath: string) => {
                const relativeFilePath = filePath.replace(webContentsRootPath + "/", "");
                // Create each file as a separate BucketObject. This is slower
                // than manually copying files to the bucket, e.g. via the CLI,
                // but allows for Pulumi to track resource status. So a
                // subsequent update will delete unreferenced files.
                const contentFile = new aws.s3.BucketObject(
                    relativeFilePath,
                    {
                        key: relativeFilePath,

                        acl: "public-read",
                        bucket: this.contentBucket,
                        contentType: mime.getType(filePath) || undefined,
                        source: new pulumi.asset.FileAsset(filePath),
                    },
                    {
                        parent: this.contentBucket,
                    });
            });


        // Create the logs bucket to store CloudFront request logs.
        this.logsBucket = new aws.s3.Bucket(
            `${name}-logs`,
            {
                acl: "private",
            },
            defaultResourceOptions);

        // Optionally specify the ACM certificate to use for HTTPS requests.
        let certificateInfo = {};
        if (domainArgs) {
            certificateInfo = {
                acmCertificateArn: domainArgs.acmCertificateArn,
                sslSupportMethod: "sni-only",
            };
        }

        // Optionally specify custom error handlers.
        const customErrors = [];
        if (contentArgs.custom404Path) {
            // Fail with a friendly error message than "InvalidArgument: The parameter ResponsePagePath is invalid."
            if (!contentArgs.custom404Path.startsWith("/")) {
                throw new Error("custom404Path must be prefixed with a slash.");
            }
            customErrors.push({
                errorCode: 404,
                responseCode: 404,
                responsePagePath: contentArgs.custom404Path,
            });
        }

        // distributionArgs configures the CloudFront distribution. Relevant documentation:
        // https://docs.aws.amazon.com/AmazonCloudFront/latest/
        // https://www.terraform.io/docs/providers/aws/r/cloudfront_distribution.html
        const distributionArgs: aws.cloudfront.DistributionArgs = {
            enabled: true,
            aliases: domainArgs ? [ domainArgs.targetDomain ] : [],

            // We only specify one origin for this distribution, the S3 content bucket.
            origins: [
                {
                    originId: this.contentBucket.arn,
                    domainName: this.contentBucket.websiteEndpoint,
                    customOriginConfig: {
                        // Amazon S3 doesn't support HTTPS connections when using an S3 bucket as a website endpoint.
                        // tslint:disable-next-line
                        // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesOriginProtocolPolicy
                        originProtocolPolicy: "http-only",
                        httpPort: 80,
                        httpsPort: 443,
                        originSslProtocols: ["TLSv1.2"],
                    },
                },
            ],

            defaultRootObject: "index.html",

            // A CloudFront distribution can configure different cache behaviors based on the request path.
            // Here we just specify a single, default cache behavior which is just read-only requests to S3.
            defaultCacheBehavior: {
                targetOriginId: this.contentBucket.arn,

                viewerProtocolPolicy: "redirect-to-https",
                allowedMethods: ["GET", "HEAD", "OPTIONS"],
                cachedMethods: ["GET", "HEAD", "OPTIONS"],

                forwardedValues: {
                    cookies: { forward: "none" },
                    queryString: false,
                },

                minTtl: 0,
                defaultTtl: tenMinutes,
                maxTtl: tenMinutes,
            },

            // "All" is the most broad distribution, and also the most expensive.
            // "100" is the least broad, and also the least expensive.
            priceClass: "PriceClass_100",

            // You can customize error responses. When CloudFront recieves an error from the origin (S3) it will
            // instead return some other resource instead.
            customErrorResponses: customErrors,

            restrictions: {
                geoRestriction: {
                    restrictionType: "none",
                },
            },

            // HTTPS certificate information if applicable.
            viewerCertificate: certificateInfo,

            loggingConfig: {
                bucket: this.logsBucket.bucketDomainName,
                includeCookies: false,
                prefix: `${name}/`,
            },
        };
        this.cdn = new aws.cloudfront.Distribution(`${name}-cdn`, distributionArgs, defaultResourceOptions);

        // Create/Update DNS record if desired
        this.aRecord = undefined;
        if (domainArgs) {
            this.aRecord = createAliasRecord(domainArgs.targetDomain, this.cdn, defaultResourceOptions);
        }
     }
}
