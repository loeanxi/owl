param([Parameter(Mandatory=$true)][string]$WorkerPath)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($WorkerPath)
$interop = [regex]::Match($source, "(?s)\`$user32 = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
Add-Type -TypeDefinition $interop

# Physical rectangles from the capture coordinate contract. The 150% case is
# the observed 1359x820 outer / 1351x816 WGC mismatch. Other cases deliberately
# use different/asymmetric borders to reject a fixed pixel subtraction.
$cases = @(
  @{ Scale=1.0; Width=906; Height=547; Insets=@(0,0,0,0); Client=@(4,0); ExpectedCrop=@(4,40,843,472); ExpectedSize=@(906,547) },
  @{ Scale=1.5; Width=1359; Height=820; Insets=@(4,0,4,4); Client=@(6,0); ExpectedCrop=@(2,60,1264,708); ExpectedSize=@(1351,816) },
  @{ Scale=2.0; Width=1812; Height=1094; Insets=@(5,1,7,3); Client=@(8,0); ExpectedCrop=@(3,79,1686,944); ExpectedSize=@(1800,1090) }
)
foreach ($case in $cases) {
  $outer = New-Object OwlMirrorWin32+RECT
  $outer.Left = -19511; $outer.Top = -19788
  $outer.Right = $outer.Left + $case.Width; $outer.Bottom = $outer.Top + $case.Height
  $capture = New-Object OwlMirrorWin32+RECT
  $capture.Left = $outer.Left + $case.Insets[0]; $capture.Top = $outer.Top + $case.Insets[1]
  $capture.Right = $outer.Right - $case.Insets[2]; $capture.Bottom = $outer.Bottom - $case.Insets[3]
  $client = New-Object OwlMirrorWin32+PT
  $client.X = $outer.Left + $case.Client[0]; $client.Y = $outer.Top + $case.Client[1]
  $bounds = [OwlMirrorWin32]::ProjectionBoundsFromRects($outer, $capture, $client, $case.Scale)
  $actualCrop = @($bounds.Crop.Left, $bounds.Crop.Top, ($bounds.Crop.Right-$bounds.Crop.Left), ($bounds.Crop.Bottom-$bounds.Crop.Top))
  $actualSize = @(($bounds.Capture.Right-$bounds.Capture.Left), ($bounds.Capture.Bottom-$bounds.Capture.Top))
  if (($actualSize -join ',') -ne ($case.ExpectedSize -join ',')) { throw "Capture dimensions do not match WGC at scale $($case.Scale)" }
  if (($actualCrop -join ',') -ne ($case.ExpectedCrop -join ',')) { throw "Content crop shifted at scale $($case.Scale)" }
  foreach ($fraction in @(0.0, 0.5, 1.0)) {
    $mappedX = $bounds.Crop.Left + $fraction * ($actualCrop[2] - 1) - $bounds.ClientOffset.X
    $mappedY = $bounds.Crop.Top + $fraction * ($actualCrop[3] - 1) - $bounds.ClientOffset.Y
    $expectedX = [Math]::Round(4*$case.Scale) + $fraction * ($actualCrop[2]-1) - $case.Client[0]
    $expectedY = [Math]::Round(40*$case.Scale) + $fraction * ($actualCrop[3]-1) - $case.Client[1]
    if ($mappedX -ne $expectedX -or $mappedY -ne $expectedY) { throw "Input coordinates shifted at scale $($case.Scale)" }
  }
}
Write-Output 'capture-geometry-ok'
