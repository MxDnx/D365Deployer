"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RELATIONSHIPS_TEMPLATE = exports.CUSTOMIZATIONS_TEMPLATE = void 0;
exports.generateSolutionXml = generateSolutionXml;
exports.syncSolutionWebResources = syncSolutionWebResources;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// ---------------------------------------------------------------------------
// Static XML templates
// ---------------------------------------------------------------------------
exports.CUSTOMIZATIONS_TEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <SolutionPluginAssemblies />
  <EntityDataProviders />
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>`;
exports.RELATIONSHIPS_TEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<EntityRelationships xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" />`;
// ---------------------------------------------------------------------------
// Solution.xml
// ---------------------------------------------------------------------------
function generateSolutionXml(settings) {
    const pub = `${settings.publisherPrefix}publisher`;
    return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.1.0.643" SolutionPackageVersion="9.1" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${settings.solutionUniqueName}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${settings.solutionUniqueName}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>1.0.0.0</Version>
    <Managed>2</Managed>
    <Publisher>
      <UniqueName>${pub}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${settings.publisherName}" languagecode="1033" />
      </LocalizedNames>
      <Descriptions />
      <EMailAddress xsi:nil="true"></EMailAddress>
      <SupportingWebsiteUrl xsi:nil="true"></SupportingWebsiteUrl>
      <CustomizationPrefix>${settings.publisherPrefix}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>10000</CustomizationOptionValuePrefix>
      <Addresses>
        <Address>
          <AddressNumber>1</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
          <City xsi:nil="true"></City>
          <County xsi:nil="true"></County>
          <Country xsi:nil="true"></Country>
          <Fax xsi:nil="true"></Fax>
          <FreightTermsCode xsi:nil="true"></FreightTermsCode>
          <ImportSequenceNumber xsi:nil="true"></ImportSequenceNumber>
          <Latitude xsi:nil="true"></Latitude>
          <Line1 xsi:nil="true"></Line1>
          <Line2 xsi:nil="true"></Line2>
          <Line3 xsi:nil="true"></Line3>
          <Longitude xsi:nil="true"></Longitude>
          <Name xsi:nil="true"></Name>
          <PostalCode xsi:nil="true"></PostalCode>
          <PostOfficeBox xsi:nil="true"></PostOfficeBox>
          <PrimaryContactName xsi:nil="true"></PrimaryContactName>
          <ShippingMethodCode>1</ShippingMethodCode>
          <StateOrProvince xsi:nil="true"></StateOrProvince>
          <Telephone1 xsi:nil="true"></Telephone1>
          <Telephone2 xsi:nil="true"></Telephone2>
          <Telephone3 xsi:nil="true"></Telephone3>
          <TimeZoneRuleVersionNumber xsi:nil="true"></TimeZoneRuleVersionNumber>
          <UPSZone xsi:nil="true"></UPSZone>
          <UTCOffset xsi:nil="true"></UTCOffset>
          <UTCConversionTimeZoneCode xsi:nil="true"></UTCConversionTimeZoneCode>
        </Address>
      </Addresses>
    </Publisher>
    <RootComponents />
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>`;
}
// ---------------------------------------------------------------------------
// Sync web resources into Customizations.xml and Solution.xml
// ---------------------------------------------------------------------------
function syncSolutionWebResources(stagingDir, wrNames) {
    const customizationsPath = path.join(stagingDir, 'Other', 'Customizations.xml');
    const solutionPath = path.join(stagingDir, 'Other', 'Solution.xml');
    const version = readSolutionVersion(solutionPath);
    const uniqueNames = Array.from(new Set(wrNames)).sort();
    updateCustomizationsXml(customizationsPath, uniqueNames, version);
    updateSolutionRootComponents(solutionPath, uniqueNames);
}
function readSolutionVersion(solutionPath) {
    const content = fs.readFileSync(solutionPath, 'utf8');
    const match = content.match(/<Version>([\d.]+)<\/Version>/);
    return match ? match[1] : '1.0.0.0';
}
function buildWebResourcesXml(uniqueNames, version) {
    if (uniqueNames.length === 0) {
        return '  <WebResources />';
    }
    const entries = uniqueNames.flatMap((name) => {
        const guid = generateGuid(name);
        const displayName = path.basename(name);
        const wrType = name.endsWith('.js.map') ? 4 : 3;
        return [
            '    <WebResource>',
            `      <WebResourceId>{${guid}}</WebResourceId>`,
            `      <Name>${name}</Name>`,
            `      <DisplayName>${displayName}</DisplayName>`,
            `      <WebResourceType>${wrType}</WebResourceType>`,
            `      <IntroducedVersion>${version}</IntroducedVersion>`,
            '      <IsEnabledForMobileClient>0</IsEnabledForMobileClient>',
            '      <IsAvailableForMobileOffline>0</IsAvailableForMobileOffline>',
            '      <IsCustomizable>1</IsCustomizable>',
            '      <CanBeDeleted>1</CanBeDeleted>',
            '      <IsHidden>0</IsHidden>',
            `      <FileName>/WebResources/${name}</FileName>`,
            '    </WebResource>',
        ];
    });
    return ['  <WebResources>', ...entries, '  </WebResources>'].join('\n');
}
function updateCustomizationsXml(filePath, uniqueNames, version) {
    const webResourcesXml = buildWebResourcesXml(uniqueNames, version);
    let xml = fs.readFileSync(filePath, 'utf8');
    xml = xml.includes('<WebResources')
        ? xml.replace(/<WebResources[\s\S]*?<\/WebResources>|<WebResources\s*\/>/g, webResourcesXml)
        : xml.replace(/(\s*)<Languages>/, `\n${webResourcesXml}\n$1<Languages>`);
    fs.writeFileSync(filePath, xml, 'utf8');
}
function updateSolutionRootComponents(filePath, uniqueNames) {
    const rootComponentsXml = uniqueNames.length === 0
        ? '    <RootComponents />'
        : [
            '    <RootComponents>',
            ...uniqueNames.map((n) => `      <RootComponent type="61" schemaName="${n}" behavior="0" />`),
            '    </RootComponents>',
        ].join('\n');
    let xml = fs.readFileSync(filePath, 'utf8');
    xml = xml.replace(/<RootComponents[\s\S]*?<\/RootComponents>|<RootComponents\s*\/>/g, rootComponentsXml);
    fs.writeFileSync(filePath, xml, 'utf8');
}
// ---------------------------------------------------------------------------
// Deterministic GUID based on name (MD5)
// ---------------------------------------------------------------------------
function generateGuid(name) {
    const hash = crypto.createHash('md5').update(name).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
//# sourceMappingURL=solution-xml.js.map