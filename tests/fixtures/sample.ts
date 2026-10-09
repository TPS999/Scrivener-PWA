import { readFileSync } from 'node:fs';
// A small but realistic Scrivener 3 project used by the tests.
export const SCRIVX = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<ScrivenerProject Template="No" Version="2.0" Identifier="7E1E7A0B-0000-4000-8000-000000000001" Creator="SCRMAC-3.3.6-17491" Device="TJ-Mac" Author="TJ Roark">
    <Binder>
        <BinderItem UUID="AAAAAAAA-0000-4000-8000-000000000001" Type="DraftFolder" Created="2024-01-02 10:00:00 -0500" Modified="2024-03-04 11:00:00 -0500">
            <Title>Draft</Title>
            <MetaData><IncludeInCompile>Yes</IncludeInCompile></MetaData>
            <Children>
                <BinderItem UUID="BBBBBBBB-0000-4000-8000-000000000001" Type="Folder" Created="2024-01-02 10:00:00 -0500" Modified="2024-03-04 11:00:00 -0500">
                    <Title>Chapter One</Title>
                    <MetaData><IncludeInCompile>Yes</IncludeInCompile><LabelID>1</LabelID><StatusID>2</StatusID></MetaData>
                    <TextSettings><TextSelection>0,0</TextSelection></TextSettings>
                    <Children>
                        <BinderItem UUID="CCCCCCCC-0000-4000-8000-000000000001" Type="Text" Created="2024-01-02 10:00:00 -0500" Modified="2024-03-04 11:00:00 -0500">
                            <Title>The Docks</Title>
                            <MetaData><IncludeInCompile>Yes</IncludeInCompile><LabelID>2</LabelID></MetaData>
                            <Keywords><KeywordID>0</KeywordID></Keywords>
                        </BinderItem>
                        <BinderItem UUID="CCCCCCCC-0000-4000-8000-000000000002" Type="Text" Created="2024-01-02 10:00:00 -0500" Modified="2024-03-04 11:00:00 -0500">
                            <Title>Night Shift</Title>
                            <MetaData><IncludeInCompile>No</IncludeInCompile></MetaData>
                        </BinderItem>
                    </Children>
                </BinderItem>
            </Children>
        </BinderItem>
        <BinderItem UUID="AAAAAAAA-0000-4000-8000-000000000002" Type="ResearchFolder" Created="2024-01-02 10:00:00 -0500" Modified="2024-01-02 10:00:00 -0500">
            <Title>Research</Title>
            <MetaData><IncludeInCompile>No</IncludeInCompile></MetaData>
            <Children>
                <BinderItem UUID="DDDDDDDD-0000-4000-8000-000000000001" Type="Image" Created="2024-01-02 10:00:00 -0500" Modified="2024-01-02 10:00:00 -0500">
                    <Title>Map</Title>
                    <MetaData><IncludeInCompile>No</IncludeInCompile><FileExtension>png</FileExtension></MetaData>
                </BinderItem>
            </Children>
        </BinderItem>
        <BinderItem UUID="AAAAAAAA-0000-4000-8000-000000000003" Type="TrashFolder" Created="2024-01-02 10:00:00 -0500" Modified="2024-01-02 10:00:00 -0500">
            <Title>Trash</Title>
        </BinderItem>
    </Binder>
    <Collections><Collection Type="Search" ID="X" Title="Search Results" Color="0.5 0.5 0.5"/></Collections>
    <LabelSettings><Title>Label</Title><DefaultLabelID>-1</DefaultLabelID><Labels><Label ID="-1">No Label</Label><Label ID="1" Color="0.2 0.4 0.9">Chapter</Label><Label ID="2" Color="0.1 0.8 0.3">Scene</Label></Labels></LabelSettings>
    <StatusSettings><Title>Status</Title><StatusItems><Status ID="-1">No Status</Status><Status ID="2">First Draft</Status></StatusItems></StatusSettings>
    <Keywords><Keyword ID="0"><Title>Harbour</Title><Color>0.9 0.1 0.1</Color></Keyword></Keywords>
    <CompileSettings><Format>Novel</Format></CompileSettings>
</ScrivenerProject>
`;

export const DOCKS_RTF = readFileSync(import.meta.dirname + '/docks.rtf', 'latin1');

export const DOCKS_COMMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<Comments Version="1.0">
    <Comment ID="EEEEEEEE-0000-4000-8000-000000000001" Footnote="No" Color="1.0 0.97 0.6"><![CDATA[{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0 Is this the right street?}]]></Comment>
</Comments>
`;

export const IMAGE_RTF = readFileSync(import.meta.dirname + '/image.rtf', 'latin1');
