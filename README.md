# Static Website using AWS

Pulumi package for hosting a static website on AWS infrastructure. Under the
hood, the package uses AWS S3, CloudFront, and optionally Route53.

Usage:

```typescript
import * as staticWebsite from "static-website-aws";

const contentArgs: staticWebsite.ContentArgs = {
    pathToContent: "./www",
    custom404Path: "/www/404.html",
};

const domainArgs: staticWebsite.DomainArgs = {
    targetDomain: "blog.chrsmith.io",
    acmCertificateArn: "arn:aws:acm:us-east-1:...",
};

const website = new staticWebsite.StaticWebsite("blog", contentArgs, domainArgs);
```

## Configuration

The `StaticWebsite` resource takes two arguments for configuration, `ContentArgs` and `DomainArgs`.

`ContentArgs` is required, and configures the content being served.

- `pathToContent` - A file path to the static content, relative from `Pulumi.yaml`.
- `custom404Page` (optional) - Path to the resource to return when serving a 404. Relative to `pathToContent`, must be under `pathToContent`. If not set, 404 errors will be the default one served from S3 (which isn't especially friendly).

`DomainArgs` is optional set of arguments to create a `Route53` domain record to serve the website. If you want to serve the website over a custom domain or serve it using HTTPS, you should specify `DomainArgs`.

- `targetDomain` - the domain to serve the website on, e.g. "example.com" or "www.example.com". A DNS `CNAME` record will be created to point the target domain to the CloudFront distribution. If set, a `Route53` hosed zone for the root domain must already exist. (e.g. "example.com" must already be managed by Route53 in the same AWS account you are running the Pulumi program in.)
- `acmCertificateArn` - The ARN of the Amazon Certificate Manager cert to use for HTTPS traffic to the CloudFront distribution. Must be in the `us-east-1` region and support `targetDomain`.

## Building

```bash
npm install
npm run build
npm run lint
npm publish
```

## Architecture

For details of how the AWS products are used to serve static content, you can read about how the code is structured on the
[Pulumi blog](https://blog.pulumi.com/serving-a-static-website-on-aws-with-pulumi). This package is based on the
[aws-ts-static-website](https://github.com/pulumi/examples/tree/master/aws-ts-static-website) example in the
[pulumi/examples](https://github.com/pulumi/examples) repo.
